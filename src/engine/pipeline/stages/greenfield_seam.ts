/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GREENFIELD SOLVER SEAM — flag-gated desktop native plate-solve (DEFAULT ON, desktop)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: COORDINATE (WCS / scale / matched-star sky positions are the product).
 *
 * DOUBLE-GATED: `isGreenfieldSolverEnabled()` (env `VITE_SOLVER_GREENFIELD`,
 * DEFAULT ON — disabled only by explicit `=0`) AND `isTauriRuntime()`. When both
 * hold, the wizard's step-5 solve (`stages/solve.ts::runSolve`) invokes the
 * `solve_greenfield` Tauri command — the greenfield Rust `solver-core` driven
 * natively (src-tauri/src/greenfield_solve.rs). Otherwise the LEGACY solve path runs
 * unchanged. The BROWSER build is ALWAYS legacy — the `isTauriRuntime()` gate never
 * lets the browser reach the invoke (the `@tauri-apps/api/core` import is dynamic +
 * guarded, kept out of the web chunk exactly like updater.ts / starplates_provider.ts).
 * `VITE_SOLVER_GREENFIELD=0` is the desktop COLD PATH (mirrors the libraw cold-path
 * pattern), on which the pinned reference e2e ride.
 *
 * Response contract `{ receipt, solved, hydrated_matches }` (mirrors the Rust
 * `GreenfieldResponse`): `solved` = `decision.result.solved` surfaced for direct TS
 * access; `hydrated_matches` = response-side catalog hydration (ra/dec/gmag). The
 * mapping mirrors the legacy solution builder (m6_plate_solve/solver_entry.ts) field-
 * for-field and wraps in `SolveResult = { success, solution, diagnostics }`.
 *
 * UNIT TRAP (the #1 trap): `crval` on the receipt is in DEGREES; the internal WCS
 * convention is crval-HOURS. `SkyTransform.createWCSTransform(raHours, …)` owns that
 * conversion, so we feed it `crval.ra / 15`. Residuals from `MatchRow` are in NATIVE
 * PIXELS (refine.rs `t - r`), so the legacy `residual_arcsec` field requires
 * `× scale_arcsec_px`.
 */

import { SkyTransform } from '../../core/SkyTransform';
import { buildSpatialHash } from '../../types/schema';
import type {
    DetectedStar,
    MatchedStar,
    PlateSolution,
    SolveResult,
    SolveDiagnostics,
} from '../../types/Main_types';

// ─── response types (mirror src-tauri/src/greenfield_solve.rs serde output) ────────

export interface GfSkyDeg {
    ra: number;
    dec: number;
}
export interface GfPixelXY {
    x: number;
    y: number;
}
export interface GfTanWcs {
    crval: GfSkyDeg;
    crpix: GfPixelXY;
    cd: [[number, number], [number, number]];
}
export interface GfVerifyStats {
    log_odds: number;
    n_matched: number;
    [k: string]: unknown;
}
export interface GfMatchRow {
    det_id: number;
    star_row: number;
    residual_x: number;
    residual_y: number;
    log_lr: number;
    test_order: number;
}
export interface GfSolvedResult {
    wcs: GfTanWcs;
    scale_arcsec_px: number;
    parity_sign: number;
    final_verify: GfVerifyStats;
    band: number;
    rung: number;
    hypothesis_seq: number;
    matches: GfMatchRow[];
}
export interface GfPerBandCounters {
    det_quads: number;
    probes: number;
    raw_hits: number;
    proposals: number;
    verified: number;
    bailed: number;
}
export interface GfReceipt {
    decision: {
        result: { state: string; solved: GfSolvedResult | null; search_truncated: boolean };
        search: { per_band: Record<string, GfPerBandCounters>; [k: string]: unknown };
        [k: string]: unknown;
    };
    decision_digest: string;
    telemetry: { wall_ms: number; [k: string]: unknown };
    [k: string]: unknown;
}
/** One response-side hydrated match (catalog sky/magnitude looked up by star_row). */
export interface GfHydratedMatch {
    det_id: number;
    star_row: number;
    ra: number;
    dec: number;
    gmag: number;
    residual_x: number;
    residual_y: number;
}
/** The `solve_greenfield` command response. */
export interface GreenfieldResponse {
    receipt: GfReceipt;
    solved: GfSolvedResult | null;
    hydrated_matches: GfHydratedMatch[];
}

/** One detection at the seam (typed IPC arg → Rust `DetIn`). NaN = absent. */
export interface GfDetIn {
    id: number;
    x: number;
    y: number;
    flux: number;
    /** Wire contract: null = absent/non-finite. NaN is NOT JSON — it serializes to
     *  null across the Tauri IPC boundary, so the seam sends null explicitly and the
     *  Rust side maps null → f64::NAN (peak-arm off). */
    peak_value: number | null;
    fwhm: number;
    snr: number | null;
}

// ─── flag ──────────────────────────────────────────────────────────────────────

/**
 * DEFAULT-ON greenfield toggle (desktop), read at CALL time (never cached at module
 * load). SAME POLARITY FAMILY as `isRawlerDecoderEnabled` (default-on, `'0'` disables):
 * only `VITE_SOLVER_GREENFIELD === '0'` disables it; anything else (unset, other values)
 * keeps the greenfield solver. A read error falls back to the LEGACY solver (the safe
 * default). Note this gate is only half of the seam — the browser is ALWAYS legacy via
 * the `isTauriRuntime()` gate, independent of this flag. Browser: vite env exposure.
 * Node: process.env fallback.
 */
export function isGreenfieldSolverEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_SOLVER_GREENFIELD;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_SOLVER_GREENFIELD;
        }
        return v !== '0';
    } catch {
        return false;
    }
}

// ─── scale hint (two-flow band traversal, DEFAULT OFF) ───────────────────────────
//
// Implements the "two-flow" routing the owner asked for — wide frames search
// coarse→fine, narrow frames fine→coarse — via the Tier-0 axis the study blessed:
// the solver's ALREADY-LIVE scale window (config.rs SearchPolicy.scale_lo/hi_asec),
// NOT band_order reordering. Rationale (docs/local/TWO_FLOW_SOLVER_STUDY_2026-07-22
// §1d): --band-order is COSMETIC in band-inner mode (decision- and probe-identical);
// the load-bearing lever is restricting the admissible BAND RANGE, which narrowing
// the scale window does for free (GateReject::AbscaleWindow). A WIDE prior windows
// to high scale ⇒ only coarse bands admissible (fine-band verify flood excluded); a
// NARROW prior windows to low scale ⇒ only fine bands admissible (coarse flood
// excluded). Zero Rust SEMANTICS change — the core just receives a window it already
// understands (§3 Tier 0).

/**
 * VITE_SOLVER_SCALE_HINT — DEFAULT-OFF gate for the scale-window search hint. OFF at
 * every gate: the seam sends NO window ⇒ the Rust core keeps its frozen blind default
 * [0.5, 300] ″/px ⇒ receipt/`resolved_config` byte-identical (a flag-ON default flip
 * is an owner-ruled enumerated rebaseline, never this commit). Read at CALL time
 * (never cached). VITE_ prefixed so the Tauri webview sees it via import.meta.env
 * exactly like VITE_SOLVER_GREENFIELD; process.env fallback for Node/headless.
 * Enabled ONLY by explicit '1'/'true' — unset or any other value = OFF (safe default).
 */
export function isScaleHintEnabled(): boolean {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        let v = env?.VITE_SOLVER_SCALE_HINT;
        if (v === undefined && typeof process !== 'undefined') {
            v = process.env?.VITE_SOLVER_SCALE_HINT;
        }
        return v === '1' || v === 'true';
    } catch {
        return false;
    }
}

/**
 * Multiplicative half-width of the window placed around the trusted scale prior. ×4
 * covers the combined EXIF-nominal error (zoom-quantized focal + FALLBACK_PITCH ~45%
 * mis-scale, TWO_FLOW §1e — worst case still <2×) with headroom, while the corpus
 * bimodal gap (narrow accepts ≤~4 ″/px at bands 1-4, wide accepts ≥~28 ″/px at bands
 * 10-14; a clean bands-5..9 gap, §1a) is ~7.6× — so a ×4 window never spans both
 * classes. NOT a calibrated gate: a search-order prior; the verify accept bar decides.
 */
export const SCALE_HINT_MARGIN = 4.0;
/** Solver blind-window bounds (config.rs SearchPolicy default): the hint is clamped
 *  into these, so it can only ever NARROW the admissible band range, never widen it. */
export const SCALE_HINT_MIN_ARCSEC = 0.5;
export const SCALE_HINT_MAX_ARCSEC = 300.0;
/** Narrow/wide split inside the bimodal gap (§1a). Below = narrow (fine-band accept),
 *  at/above = wide (coarse-band accept). REPORTING only — the window (not this label)
 *  is what restricts the search — surfaced for telemetry / the future drag-drop UI. */
export const SCALE_HINT_CLASS_THRESHOLD_ARCSEC = 10.0;
/** Trust cross-check: the solve-buffer scale must be a bin-consistent multiple of the
 *  optics-implied scale (native → science/2× → preview ≈ ×1–×2.7). A ratio outside
 *  this band means the scale did NOT come from the optics chain — the 2.0 ″/px blind
 *  fallback, or a scale lock that disagrees with EXIF — so we do NOT trust it. */
export const SCALE_HINT_CONSISTENCY_LO = 0.5;
export const SCALE_HINT_CONSISTENCY_HI = 8.0;

/** Inputs the seam needs to derive a TRUSTED scale window (all from SolveContextParams). */
export interface ScaleHintInput {
    /** arcsec/px of the buffer being solved (SolveContextParams.basePixelScale). */
    solveScaleArcsecPx?: number;
    /** Effective focal length (mm), OpticsManager.getEffectiveFocalLength. */
    focalLengthMm?: number;
    /** Sensor pixel pitch (µm). */
    pixelPitchUm?: number;
    /** EXIF/user lens string. A placeholder ('Unknown Lens'/'Unknown'/empty) is the
     *  lying-EXIF landmine (the bundled CR2's fake 50mm), so it disqualifies the hint. */
    lensModel?: string;
}

/** A resolved scale window + its derived class (null when no trusted prior exists). */
export interface ScaleHint {
    scaleLoAsec: number;
    scaleHiAsec: number;
    fieldClass: 'narrow' | 'wide';
    /** The prior (solve-buffer) scale the window is centered on, arcsec/px. */
    priorScaleArcsecPx: number;
}

/** 'Unknown Lens'/'Unknown'/empty are TRUTHY placeholders (lying-EXIF trap); reject. */
function isPlaceholderLens(lens: string | undefined): boolean {
    if (!lens || !lens.trim()) return true;
    return /unknown/i.test(lens);
}

/**
 * Resolve a scale-window search hint from a TRUSTED scale prior, or null when no
 * trustworthy prior exists. PURE and FLAG-INDEPENDENT (the flag is applied by the
 * caller) so the gating logic is unit-testable in isolation. All gates must pass:
 *   1. finite focal>0, pitch>0, solve-scale>0;
 *   2. lens is not a placeholder (lying-EXIF guard — TWO_FLOW §3 hinter ladder);
 *   3. the solve-scale is bin-consistent with the optics-implied scale (rejects the
 *      blind 2.0 ″/px fallback and a scale lock that disagrees with the EXIF optics).
 * On success the window = [scale/MARGIN, scale·MARGIN] clamped to [MIN,MAX]: a WIDE
 * prior excludes the fine bands (coarse-first flow), a NARROW prior excludes the
 * coarse bands (fine-first flow). Hint-liberality holds — a wrong window only wastes
 * time and falls back to blind; the verify accept bar is never touched.
 */
export function resolveScaleHint(input: ScaleHintInput): ScaleHint | null {
    const scale = input.solveScaleArcsecPx;
    const focal = input.focalLengthMm;
    const pitch = input.pixelPitchUm;
    if (!(typeof scale === 'number' && Number.isFinite(scale) && scale > 0)) return null;
    if (!(typeof focal === 'number' && Number.isFinite(focal) && focal > 0)) return null;
    if (!(typeof pitch === 'number' && Number.isFinite(pitch) && pitch > 0)) return null;
    if (isPlaceholderLens(input.lensModel)) return null;

    // Optics-implied NATIVE scale (206.265 · pitch / focal, the m2_hardware geometry).
    // The solve-buffer scale must be a bin-multiple of it (native/science/preview),
    // else the scale is not optics-sourced ⇒ not trusted (2.0 blind fallback / lock).
    const impliedNative = (206.265 * pitch) / focal;
    if (!(impliedNative > 0)) return null;
    const ratio = scale / impliedNative;
    if (!(ratio >= SCALE_HINT_CONSISTENCY_LO && ratio <= SCALE_HINT_CONSISTENCY_HI)) return null;

    const lo = Math.max(SCALE_HINT_MIN_ARCSEC, scale / SCALE_HINT_MARGIN);
    const hi = Math.min(SCALE_HINT_MAX_ARCSEC, scale * SCALE_HINT_MARGIN);
    if (!(lo < hi)) return null; // degenerate clamp ⇒ no hint (honest-or-absent)
    const fieldClass: 'narrow' | 'wide' =
        scale >= SCALE_HINT_CLASS_THRESHOLD_ARCSEC ? 'wide' : 'narrow';
    return { scaleLoAsec: lo, scaleHiAsec: hi, fieldClass, priorScaleArcsecPx: scale };
}

// ─── mapping (pure; unit-testable) ───────────────────────────────────────────────

/**
 * Map a `GreenfieldResponse` to the legacy `PlateSolution`, mirroring the m6 solution
 * builder (solver_entry.ts:2531-2558) field-for-field. Returns `null` for any non-Solved
 * terminal state (→ the existing failure path). `detections` is the SUBMITTED detection
 * array (contract id = array index — the drain-proven basis; conformance re-drain matched
 * exactly), used to recover per-match pixel positions by `det_id`.
 */
export function mapGreenfieldSolution(
    resp: GreenfieldResponse,
    detections: DetectedStar[],
    width: number,
    height: number,
): PlateSolution | null {
    const s = resp.solved;
    if (!s || resp.receipt.decision.result.state !== 'Solved') return null;

    // #1 unit trap: crval is DEGREES on the receipt; the WCS builder owns crval-HOURS.
    const crvalRaDeg = s.wcs.crval.ra;
    const crvalDecDeg = s.wcs.crval.dec;
    const raHours = crvalRaDeg / 15;
    const scale = s.scale_arcsec_px;
    const parity = s.parity_sign;
    // Rotation extracted from the receipt CD via the canonical inverse (the same helper
    // the legacy path round-trips through), then a clean similarity WCS is rebuilt about
    // crpix — exactly as the legacy builder constructs its WCS via createWCSTransform.
    const rotation = SkyTransform.rotationFromCD(s.wcs.cd);
    const crpix: [number, number] = [s.wcs.crpix.x, s.wcs.crpix.y];
    const wcs = SkyTransform.createWCSTransform(raHours, crvalDecDeg, scale, rotation, parity, crpix);

    // Honest Bayesian posterior from the receipt's FINAL verify log-odds (≈1.0 for real
    // solves — expected); log_odds carried explicitly in the additive block.
    const logOdds = s.final_verify.log_odds;
    const confidence = 1 / (1 + Math.exp(-logOdds));

    // matched_stars: per hydrated match, pixel x/y from the submitted detections by
    // det_id, catalog ra/dec/mag from hydration. residual_x/y are NATIVE PIXELS
    // (refine.rs), so residual_arcsec = |residual|_px × scale (arcsec/px).
    const matched_stars: MatchedStar[] = [];
    for (const h of resp.hydrated_matches) {
        const det = detections[h.det_id];
        if (!det) continue; // out-of-range det_id (should not happen) — skip, never fake one
        matched_stars.push({
            detected: det,
            catalog: {
                ra: h.ra,
                dec: h.dec,
                mag: h.gmag,
                ra_hours: h.ra / 15,
                dec_degrees: h.dec,
                gaia_id: String(h.star_row),
                band: 'GaiaG',
            },
            residual: { dx: h.residual_x, dy: h.residual_y },
            residual_arcsec: Math.hypot(h.residual_x, h.residual_y) * scale,
        });
    }

    const solution: PlateSolution = {
        ra: raHours * 15, // DEGREES (legacy top-level convention)
        dec: crvalDecDeg,
        ra_hours: raHours,
        dec_degrees: crvalDecDeg,
        rotation,
        rotation_deg: rotation,
        pixel_scale: scale,
        fov_width_deg: (width * scale) / 3600,
        fov_height_deg: (height * scale) / 3600,
        parity,
        spatial_hash: buildSpatialHash(raHours, crvalDecDeg),
        confidence,
        num_stars: matched_stars.length,
        wcs,
        matched_stars,
        solved_via: 'greenfield_rust',
        greenfield_receipt: resp.receipt,
        greenfield_log_odds: logOdds,
    };
    return solution;
}

/** Honest `SolveDiagnostics` from the receipt (diagnostic-only; buildReceipt never reads it). */
export function buildGreenfieldDiagnostics(
    resp: GreenfieldResponse,
    solution: PlateSolution | null,
): SolveDiagnostics {
    const perBand = resp.receipt.decision.search?.per_band ?? {};
    let detQuads = 0;
    let rawHits = 0;
    for (const k of Object.keys(perBand)) {
        detQuads += perBand[k]?.det_quads ?? 0;
        rawHits += perBand[k]?.raw_hits ?? 0;
    }
    const matches = resp.solved?.matches.length ?? 0;
    return {
        solve_time_ms: resp.receipt.telemetry?.wall_ms ?? 0,
        quads_detected: detQuads,
        quads_catalog: rawHits,
        matches_found: matches,
        verified_clusters: solution ? 1 : 0,
        // peak_background_ratio: ABSENT — the greenfield path runs no background
        // model (honest NOT MEASURED, never a fake 0; receipt boundary → null).
        rejection_reasons: solution
            ? []
            : [`greenfield: ${resp.receipt.decision.result.state}`],
    };
}

// ─── invoke wrapper ──────────────────────────────────────────────────────────────

/**
 * Invoke `solve_greenfield` with the CURRENT detections and map to `SolveResult`. The
 * `@tauri-apps/api/core` import is dynamic + guarded so the browser build stays clean
 * (the caller already gates on `isTauriRuntime()`).
 */
export async function solveViaGreenfield(
    imageData: ImageData,
    existingStars: DetectedStar[] | undefined,
    budgetMs?: number,
    scaleHintInput?: ScaleHintInput,
): Promise<SolveResult> {
    const width = imageData.width;
    const height = imageData.height;
    const stars = existingStars ?? [];
    // Contract id = ARRAY INDEX; DetectedStar carries no normalized peak_value, so the
    // raw peak_adu (rank-equivalent) rides the peak-arm slot; absent → NaN (peak-arm off).
    // JSON cannot carry NaN: non-finite → null on the wire (Rust maps null → NAN).
    // Stars with non-finite REQUIRED fields are dropped BEFORE id assignment so the
    // id-equals-array-index contract stays aligned with the array used for recovery.
    const finiteOrNull = (v: number | undefined): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
    const submitted = stars.filter(
        (s) =>
            Number.isFinite(s.x) &&
            Number.isFinite(s.y) &&
            Number.isFinite(s.flux) &&
            Number.isFinite(s.fwhm),
    );
    const detections: GfDetIn[] = submitted.map((s, i) => ({
        id: i,
        x: s.x,
        y: s.y,
        flux: s.flux,
        peak_value: finiteOrNull(s.peak_adu),
        fwhm: s.fwhm,
        snr: finiteOrNull(s.snr),
    }));

    const { invoke } = await import('@tauri-apps/api/core');
    const args: Record<string, unknown> = { detections, width, height };
    if (budgetMs !== undefined) args.budgetMs = budgetMs;
    // Two-flow scale hint (VITE_SOLVER_SCALE_HINT, DEFAULT OFF): only a flag-ON call
    // WITH a trusted prior narrows the search window (scaleLo/scaleHi → Rust
    // scale_lo/scale_hi → config.search.scale_lo/hi_asec). Otherwise no window keys
    // are sent ⇒ the Rust core runs its frozen blind default [0.5,300] ⇒ receipt
    // byte-identical. resolveScaleHint returns null on any untrusted/absent prior.
    if (isScaleHintEnabled() && scaleHintInput) {
        const hint = resolveScaleHint(scaleHintInput);
        if (hint) {
            args.scaleLo = hint.scaleLoAsec;
            args.scaleHi = hint.scaleHiAsec;
            console.log(
                `[greenfield] scale hint ON — ${hint.fieldClass} field, prior ${hint.priorScaleArcsecPx.toFixed(2)} ″/px → window [${hint.scaleLoAsec.toFixed(2)}, ${hint.scaleHiAsec.toFixed(2)}] ″/px`,
            );
        }
    }
    const resp = await invoke<GreenfieldResponse>('solve_greenfield', args);

    const solution = mapGreenfieldSolution(resp, submitted, width, height);
    const diagnostics = buildGreenfieldDiagnostics(resp, solution);
    return { success: !!solution, solution: solution ?? undefined, diagnostics };
}
