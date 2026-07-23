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
    const resp = await invoke<GreenfieldResponse>('solve_greenfield', args);

    const solution = mapGreenfieldSolution(resp, submitted, width, height);
    const diagnostics = buildGreenfieldDiagnostics(resp, solution);
    return { success: !!solution, solution: solution ?? undefined, diagnostics };
}
