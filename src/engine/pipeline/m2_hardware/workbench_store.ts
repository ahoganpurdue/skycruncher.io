// ═══════════════════════════════════════════════════════════════════════════
// OPTICAL WORKBENCH — per-rig profile store (COORDINATE-ledger metadata layer)
// ═══════════════════════════════════════════════════════════════════════════
// Spec: docs/OPTICAL_WORKBENCH_SCHEMA.md (owner-ratified 2026-07-09). This module
// is the persist layer + derived-recompute for the two-layer design:
//
//   1. OBSERVATION LOG (append-only) — every solve DEPOSITS a compact row of the
//      raw MEASURED facts it produced (BC k1/k2 + coverage, SIP, TPS, PSF field
//      summary, zero-point, bc_rematch outcome), each CITING the receipt hash.
//      Never overwritten, never averaged in place.
//   2. DERIVED RUNNING STATE (recomputed, versioned) — `recomputeRigProfile`
//      regenerates the pooled "running best fit" mechanically from the log.
//      Every derived value carries `mean ± σ, N, coverage, epoch` and the
//      contributing receipt hashes (auditability).
//
// ─── SCOPE / LEDGER ────────────────────────────────────────────────────────────
// This is OBSERVATIONAL. It reads a FINISHED receipt and writes a side-channel
// row. It NEVER mutates the solution/receipt and NEVER feeds the solve — rung-3
// (pooled prior APPLIED to a solve) is EXPLICITLY OUT OF SCOPE here (ladder-gated,
// future). Drift detection below is COMPARATIVE bookkeeping, NOT a calibrated
// solver gate — none of these numbers are SOLVER_* / GATES.md constants.
//
// ─── PRIVACY (README, owner ruling) ────────────────────────────────────────────
// The store is LOCAL-ONLY. Body serials + rig identity are IDENTIFYING. Per the
// sextant privacy design, the store is default-private and redactable. NO EXPORT
// PATH (network, cloud, C2PA-signed passport) may be added to this store without
// first implementing the redaction/tiering design — see the "Privacy tier from
// day one" clause in docs/OPTICAL_WORKBENCH_SCHEMA.md. A deposit already avoids
// bulk PII by storing COMPACT rows that cite receipt hashes rather than copying
// full receipts.
// ═══════════════════════════════════════════════════════════════════════════════

import { deriveTrainHashFromMetadata } from './optical_train';

/** Schema version for the compact deposit row + derived profile. Bumped to 1.1.0
 *  for the ADDITIVE `train_hash` field (optical-train fingerprint keying); all
 *  1.0.0 rows read back unchanged (train_hash absent → treated as null). */
export const WORKBENCH_SCHEMA_VERSION = '1.1.0';

// ─── KEYING ──────────────────────────────────────────────────────────────────
// Key = (body_serial × lens_id). Body serial when the reaper surfaces it; else a
// stable fallback of body model + lens string. NEVER focal length (lying-EXIF
// trap). The key QUALITY is recorded honestly.
//
// SECOND KEY (additive, owner Feb-2026 spec): the OPTICAL-TRAIN HASH
// SHA256(camera + lens + filter) — a config-identity fingerprint of the SETUP,
// independent of body serial. A previously-calibrated train seeds a solve
// directly (rung-0). The two keys are complementary: rig_key (serial) identifies
// a physical COPY; train_hash identifies the OPTICAL CONFIGURATION. New deposits
// carry BOTH; existing MODEL_ONLY rows remain the fallback tier (no migration).

export type RigKeyQuality = 'SERIAL' | 'MODEL_ONLY';

export interface RigKey {
    /** Stable composite grouping key. */
    key: string;
    quality: RigKeyQuality;
    /** Body identity component (camera model, serial-qualified when available). */
    body: string;
    /** Lens/telescope identity component (model string). */
    lens: string;
    /** Body serial when the reaper surfaced one; null otherwise (→ MODEL_ONLY). */
    body_serial: string | null;
    /**
     * Optical-train fingerprint SHA256(camera+lens+filter) — the ADDITIVE second
     * key. Null when the train has no identity to hash (camera AND lens both
     * absent/placeholder). See optical_train.ts for the canonical recipe.
     */
    train_hash: string | null;
}

const UNKNOWN = 'UNKNOWN';

function norm(s: unknown): string {
    if (typeof s !== 'string') return UNKNOWN;
    const t = s.trim();
    return t.length ? t : UNKNOWN;
}

/**
 * Derive the rig key from a receipt's `metadata` block. The reaper does not
 * currently surface a body serial into HardMetadata, so a serial is read
 * defensively from any of a few honest carrier fields — when absent the key
 * degrades to MODEL_ONLY (body model × lens string). Focal length is NEVER a
 * key component (it is recorded elsewhere for context only).
 */
export function deriveRigKey(metadata: any | null | undefined): RigKey {
    const body = norm(metadata?.camera_model);
    const lens = norm(metadata?.lens_model);
    // Honest serial carriers (none wired today, but future-safe): explicit
    // camera serial fields the reaper may surface. Never fabricated.
    const serialRaw =
        metadata?.body_serial ??
        metadata?.camera_serial ??
        metadata?.serial_number ??
        metadata?.serial ??
        null;
    const serial = typeof serialRaw === 'string' && serialRaw.trim().length ? serialRaw.trim() : null;

    // Additive optical-train fingerprint (SHA256(camera+lens+filter)); null when
    // there is no train identity to hash. Independent of body serial.
    const train_hash = deriveTrainHashFromMetadata(metadata);

    if (serial) {
        return {
            key: `${body}#${serial}|${lens}`,
            quality: 'SERIAL',
            body: `${body}#${serial}`,
            lens,
            body_serial: serial,
            train_hash,
        };
    }
    return {
        key: `${body}|${lens}`,
        quality: 'MODEL_ONLY',
        body,
        lens,
        body_serial: null,
        train_hash,
    };
}

// ─── DEPOSIT ROW (compact per-solve observation) ─────────────────────────────

export interface DepositBC {
    /** true when a MEASURED Brown-Conrady k1 was actually fitted (not `not_measured`). */
    measured: boolean;
    k1: number | null;
    k2: number | null;
    /** Fit uncertainties (for inverse-variance / coverage-weighted pooling). */
    k1_sigma: number | null;
    k2_sigma: number | null;
    n_pairs: number | null;
    n_used: number | null;
    r_max_sampled: number | null;
    /** Per-octant pair counts (length 8, image convention) — coverage union input. */
    octant_counts: number[] | null;
    coverage_refused: { k2: boolean; k3: boolean; tangential: boolean } | null;
    mustache_verdict: string | null;
    /** Honest-absent reason when coverage could not fit even k1. */
    not_measured: string | null;
}

export interface DepositSIP {
    present: boolean;
    a_order: number | null;
    b_order: number | null;
    rms_arcsec: number | null;
}

export interface DepositTPS {
    present: boolean;
    control_count: number | null;
    rms_after_arcsec: number | null;
}

export interface DepositPSF {
    measured: boolean;
    fwhm_median_maj_px: number | null;
    fwhm_median_min_px: number | null;
    ellipticity_median: number | null;
    n_fit: number | null;
    method: string | null;
}

export interface DepositBcRematch {
    present: boolean;
    guard: 'APPLIED' | 'KEPT_ORIGINAL' | null;
    applied: boolean | null;
    matched_before: number | null;
    matched_after: number | null;
    edge_before: number | null;
    edge_after: number | null;
}

export interface ObservationDeposit {
    schema: string;
    // ─ identity ─
    rig_key: string;
    key_quality: RigKeyQuality;
    body: string;
    lens: string;
    body_serial: string | null;
    /**
     * Optical-train fingerprint SHA256(camera+lens+filter) — ADDITIVE second key
     * (schema 1.1.0+). Optional so pre-1.1.0 rows and literal test builders remain
     * valid; readers treat an absent value as null. Stamped when camera/lens
     * metadata exists (deriveRigKey); null for an unidentifiable train.
     */
    train_hash?: string | null;
    /** Epoch this deposit was assigned to (fork on drift). 0 for the first. */
    epoch: number;
    // ─ provenance ─
    /** Capture timestamp (ISO) from metadata; null when unset. */
    captured_at: string | null;
    /** False when the capture clock was a wall-clock fallback (unset-clock forensics). */
    timestamp_trusted: boolean;
    /** Wall-clock time this row was recorded. */
    deposited_at: string;
    /** Content hash of the receipt (export_date excluded) — cites the source. */
    receipt_hash: string;
    // ─ context anchors (recorded, NOT keys) ─
    aperture: number | null;
    /** Focal length (mm) recorded for context ONLY — NEVER a key component. */
    focal_length_mm: number | null;
    pixel_scale_arcsec: number | null;
    stars_matched: number | null;
    // ─ measured facts ─
    bc: DepositBC;
    sip: DepositSIP;
    tps: DepositTPS;
    psf: DepositPSF;
    zero_point: number | null;
    zero_point_rmse: number | null;
    bc_rematch: DepositBcRematch;
}

// ─── RECEIPT HASH (stable content fingerprint; export_date excluded) ──────────

/** cyrb53 — good-distribution 53-bit string hash (public-domain). */
function cyrb53(str: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Content fingerprint of a receipt, used to CITE the source receipt a deposit
 * was drawn from (auditability). Strips typed arrays (they may still be live refs
 * at deposit time) and EXCLUDES the top-level `export_date` wall-clock stamp so
 * the hash is content-anchored rather than a bare timestamp. HONEST CAVEAT: the
 * receipt still embeds run-specific timing (solve_time_ms, psf timings), so two
 * re-runs of the SAME frame produce DIFFERENT hashes — which is correct for
 * auditability (each hash identifies one receipt instance), NOT a dedup key.
 * Never throws — returns a sentinel on serialization failure.
 */
export function hashReceipt(receipt: any): string {
    try {
        const json = JSON.stringify(receipt, (key, value) => {
            if (key === 'export_date') return undefined;
            if (ArrayBuffer.isView(value)) return undefined; // Float32Array etc.
            return value;
        });
        return 'r53_' + cyrb53(json ?? '').toString(16);
    } catch {
        return 'r53_unhashable';
    }
}

// ─── DEPOSIT EXTRACTION (pure read from a FINISHED receipt) ───────────────────

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Extract a compact deposit row from a finished wizard receipt. PURE — reads the
 * receipt, mutates nothing. Returns null when there is no solution (nothing to
 * pool). `epoch` is left at 0 here; the storage layer assigns the real epoch
 * (drift fork) against the rig's prior deposits before appending.
 */
export function extractDeposit(receipt: any): ObservationDeposit | null {
    if (!receipt || receipt.solution == null) return null;

    const rig = deriveRigKey(receipt.metadata);
    const sol = receipt.solution;
    const md = receipt.metadata ?? {};

    // BC (lens_distortion_measured — serialized MeasuredDistortion block)
    const bcSrc = receipt.lens_distortion_measured;
    const bcMeasured = !!bcSrc && !bcSrc.not_measured;
    const bc: DepositBC = {
        measured: bcMeasured,
        k1: bcMeasured ? num(bcSrc.k1) : null,
        k2: bcSrc ? num(bcSrc.k2) : null,
        k1_sigma: num(bcSrc?.coefficients?.k1?.sigma),
        k2_sigma: num(bcSrc?.coefficients?.k2?.sigma),
        n_pairs: num(bcSrc?.n_pairs),
        n_used: num(bcSrc?.n_used),
        r_max_sampled: num(bcSrc?.r_max_sampled),
        octant_counts: Array.isArray(bcSrc?.octant_counts) ? bcSrc.octant_counts.map((c: any) => num(c) ?? 0) : null,
        coverage_refused: bcSrc?.coverage_refused ?? null,
        mustache_verdict: bcSrc?.mustache?.verdict ?? null,
        not_measured: bcSrc?.not_measured ?? null,
    };

    // SIP / TPS (solution.astrometry)
    const astro = sol.astrometry ?? null;
    const sip: DepositSIP = {
        present: !!astro?.sip,
        a_order: num(astro?.sip?.a_order),
        b_order: num(astro?.sip?.b_order),
        rms_arcsec: num(astro?.rms_arcsec),
    };
    const tps: DepositTPS = {
        present: !!astro?.tps,
        control_count: num(astro?.tps?.control_count),
        rms_after_arcsec: num(astro?.tps?.rms_after_arcsec),
    };

    // PSF field summary (serialized psf_field block)
    const psfSrc = receipt.psf_field;
    const psfMeasured = !!psfSrc && psfSrc.method !== 'NOT_MEASURED' && !psfSrc.not_measured;
    const psf: DepositPSF = {
        measured: psfMeasured,
        fwhm_median_maj_px: num(psfSrc?.fwhm_median_maj_px),
        fwhm_median_min_px: num(psfSrc?.fwhm_median_min_px),
        ellipticity_median: num(psfSrc?.ellipticity_median),
        n_fit: num(psfSrc?.n_fit),
        method: psfSrc?.method ?? null,
    };

    // Zero-point (SPCC block; only when the color regression converged)
    const spcc = receipt.spcc;
    const zpValid = !!spcc && spcc.source === 'SPCC_RGB';

    // bc_rematch outcome (solution.bc_rematch)
    const rm = sol.bc_rematch;
    const bc_rematch: DepositBcRematch = {
        present: !!rm,
        guard: rm?.guard ?? null,
        applied: typeof rm?.applied === 'boolean' ? rm.applied : null,
        matched_before: num(rm?.matched_before),
        matched_after: num(rm?.matched_after),
        edge_before: num(rm?.edge_before),
        edge_after: num(rm?.edge_after),
    };

    return {
        schema: WORKBENCH_SCHEMA_VERSION,
        rig_key: rig.key,
        key_quality: rig.quality,
        body: rig.body,
        lens: rig.lens,
        body_serial: rig.body_serial,
        train_hash: rig.train_hash,
        epoch: 0,
        captured_at: typeof md.timestamp === 'string' ? md.timestamp : null,
        timestamp_trusted: receipt.timestamp_trusted === true,
        deposited_at: new Date().toISOString(),
        receipt_hash: hashReceipt(receipt),
        aperture: num(md.aperture),
        focal_length_mm: num(md.focal_length),
        pixel_scale_arcsec: num(sol.pixel_scale),
        stars_matched: num(sol.stars_matched),
        bc,
        sip,
        tps,
        psf,
        zero_point: zpValid ? num(spcc.zeropoint) : null,
        zero_point_rmse: zpValid ? num(spcc.zp_rmse) : null,
        bc_rematch,
    };
}

// ─── WEIGHTED POOLING ─────────────────────────────────────────────────────────

/**
 * Coverage-weighted mean ± σ. Weight = inverse fit variance (1/σ²) when a
 * per-coefficient σ is available — a poorly-covered fit has a larger σ and thus
 * a smaller weight, so this IS coverage-weighting in effect. Falls back to
 * n_used (pair count) then uniform when σ is absent. σ_out is the weighted
 * sample DISPERSION across frames (Bessel-corrected), i.e. how consistent the
 * rig is — NOT the standard error of the mean (drift detection compares against
 * this dispersion).
 */
export function weightedMeanSigma(
    values: number[],
    weights: number[],
): { mean: number; sigma: number | null; n: number; weightTotal: number } {
    const n = values.length;
    if (n === 0) return { mean: NaN, sigma: null, n: 0, weightTotal: 0 };
    let wsum = 0, wxsum = 0;
    for (let i = 0; i < n; i++) { wsum += weights[i]; wxsum += weights[i] * values[i]; }
    if (!(wsum > 0)) {
        // degenerate weights → unweighted
        const mean = values.reduce((s, v) => s + v, 0) / n;
        return { mean, sigma: dispersion(values, values.map(() => 1), mean, n), n, weightTotal: 0 };
    }
    const mean = wxsum / wsum;
    return { mean, sigma: dispersion(values, weights, mean, n), n, weightTotal: wsum };
}

function dispersion(values: number[], weights: number[], mean: number, n: number): number | null {
    if (n < 2) return null; // spread is undefined for a single frame (honest-absent)
    let wsum = 0, wss = 0;
    for (let i = 0; i < n; i++) { wsum += weights[i]; wss += weights[i] * (values[i] - mean) ** 2; }
    if (!(wsum > 0)) return null;
    // population weighted variance × small-sample (Bessel) correction
    const variance = (wss / wsum) * (n / (n - 1));
    return Math.sqrt(Math.max(0, variance));
}

/** Weight for one deposit's BC coefficient: inverse fit-variance, else n_used, else 1. */
function bcWeight(sigma: number | null, nUsed: number | null): number {
    if (sigma != null && sigma > 0) return 1 / (sigma * sigma);
    if (nUsed != null && nUsed > 0) return nUsed;
    return 1;
}

// ─── DRIFT DETECTION (COMPARATIVE — not a calibrated gate) ────────────────────
// A new fit FORKS a new epoch when it is incompatible with the current epoch's
// pooled physics. Two comparative triggers, both self-referential to the pool's
// OWN spread (never an absolute magic constant):
//   (a) SIGN FLIP — new k1 sign differs from the pooled-mean k1 sign, AND both
//       magnitudes clear the pool's own dispersion (so pure noise-sign-flip near
//       zero does NOT fork).
//   (b) >3σ DEPARTURE — |new.k1 − pool.mean| exceeds 3× the pool's dispersion.
// Requires N≥2 measured fits in the current epoch (σ undefined below that). The
// "3" is a documented comparative multiplier on the pool's own σ, deliberately
// NOT a SOLVER_* constant.

export const WORKBENCH_DRIFT_SIGMA = 3;

export interface DriftVerdict { drift: boolean; reason: string | null; }

/**
 * Decide whether `candidate` drifts from the pool of prior measured-BC k1 values
 * in the SAME (current) epoch. `poolK1` / `poolW` are the current epoch's k1
 * values + weights (measured fits only).
 */
export function detectDrift(poolK1: number[], poolW: number[], candidateK1: number | null): DriftVerdict {
    if (candidateK1 == null || poolK1.length < 2) return { drift: false, reason: null };
    const { mean, sigma } = weightedMeanSigma(poolK1, poolW);
    if (sigma == null || !(sigma > 0)) return { drift: false, reason: null };
    const departure = Math.abs(candidateK1 - mean);
    // (a) sign flip clearing dispersion on both sides
    const signFlip =
        Math.sign(candidateK1) !== Math.sign(mean) &&
        Math.abs(candidateK1) > sigma &&
        Math.abs(mean) > sigma;
    if (signFlip) {
        return { drift: true, reason: `k1 sign flip vs pooled mean (new=${candidateK1.toExponential(3)}, pool=${mean.toExponential(3)}, σ=${sigma.toExponential(3)})` };
    }
    // (b) >3σ departure
    if (departure > WORKBENCH_DRIFT_SIGMA * sigma) {
        return { drift: true, reason: `k1 ${(departure / sigma).toFixed(1)}σ departure vs pooled mean (>${WORKBENCH_DRIFT_SIGMA}σ)` };
    }
    return { drift: false, reason: null };
}

/**
 * Assign the epoch for a new deposit given the rig's prior deposits (any order).
 * The candidate joins the latest epoch unless it drifts, in which case it forks
 * epoch = maxPriorEpoch + 1. First-ever deposit → epoch 0.
 */
export function assignEpoch(prior: ObservationDeposit[], candidate: ObservationDeposit): number {
    if (!prior.length) return 0;
    let maxEpoch = 0;
    for (const d of prior) if (d.epoch > maxEpoch) maxEpoch = d.epoch;
    // pool = measured-BC deposits in the latest epoch
    const poolDeposits = prior.filter(d => d.epoch === maxEpoch && d.bc.measured && d.bc.k1 != null);
    const poolK1 = poolDeposits.map(d => d.bc.k1 as number);
    const poolW = poolDeposits.map(d => bcWeight(d.bc.k1_sigma, d.bc.n_used));
    if (!candidate.bc.measured || candidate.bc.k1 == null) return maxEpoch; // can't drift-test → stay
    const { drift } = detectDrift(poolK1, poolW, candidate.bc.k1);
    return drift ? maxEpoch + 1 : maxEpoch;
}

// ─── DERIVED PROFILE (recompute v1 — pooled BC per epoch) ─────────────────────

export interface EpochProfile {
    epoch: number;
    /** # deposits contributing a measured BC k1 to the pool. */
    n: number;
    /** total deposits in the epoch (incl. unmeasured-BC). */
    n_deposits_total: number;
    k1_mean: number | null;
    k1_sigma: number | null;
    k2_mean: number | null;
    k2_sigma: number | null;
    /** union of occupied octants (≥1 pair) across the epoch's measured fits, 0..8. */
    coverage_octants_union: number;
    /** best (max) normalized radius sampled across the epoch. */
    r_max: number | null;
    first_captured_at: string | null;
    last_captured_at: string | null;
    /** Contributing receipt hashes (auditability — the profile cites its sources). */
    receipt_hashes: string[];
    /** Sum of coverage weights behind the pooled k1 (transparency). */
    weight_total: number;
}

export interface RigProfile {
    schema: string;
    rig_key: string;
    key_quality: RigKeyQuality;
    body: string;
    lens: string;
    body_serial: string | null;
    n_deposits: number;
    current_epoch: number;
    epochs: EpochProfile[];
    generated_at: string;
    /**
     * Derived state is COMPARATIVE bookkeeping. It is NEVER applied to a solve
     * here — rung-3 (pooled prior seeds the first pass) is out of scope.
     */
    application: 'NONE';
}

function poolEpoch(epoch: number, deposits: ObservationDeposit[]): EpochProfile {
    const measured = deposits.filter(d => d.bc.measured && d.bc.k1 != null);
    // k1 pool (coverage-weighted)
    const k1v = measured.map(d => d.bc.k1 as number);
    const k1w = measured.map(d => bcWeight(d.bc.k1_sigma, d.bc.n_used));
    const k1 = k1v.length ? weightedMeanSigma(k1v, k1w) : null;
    // k2 pool — only deposits that actually fitted k2
    const k2dep = measured.filter(d => d.bc.k2 != null);
    const k2v = k2dep.map(d => d.bc.k2 as number);
    const k2w = k2dep.map(d => bcWeight(d.bc.k2_sigma, d.bc.n_used));
    const k2 = k2v.length ? weightedMeanSigma(k2v, k2w) : null;
    // coverage union of occupied octants
    const union = new Array(8).fill(false);
    for (const d of measured) {
        const oc = d.bc.octant_counts;
        if (oc) for (let i = 0; i < 8 && i < oc.length; i++) if (oc[i] >= 1) union[i] = true;
    }
    const rMaxVals = measured.map(d => d.bc.r_max_sampled).filter((r): r is number => r != null);
    const times = deposits.map(d => d.captured_at).filter((t): t is string => !!t).sort();

    return {
        epoch,
        n: measured.length,
        n_deposits_total: deposits.length,
        k1_mean: k1 ? k1.mean : null,
        k1_sigma: k1 ? k1.sigma : null,
        k2_mean: k2 ? k2.mean : null,
        k2_sigma: k2 ? k2.sigma : null,
        coverage_octants_union: union.filter(Boolean).length,
        r_max: rMaxVals.length ? Math.max(...rMaxVals) : null,
        first_captured_at: times[0] ?? null,
        last_captured_at: times[times.length - 1] ?? null,
        receipt_hashes: measured.map(d => d.receipt_hash),
        weight_total: k1 ? k1.weightTotal : 0,
    };
}

/**
 * Recompute the derived running state for a rig from its deposit log. Pure —
 * groups by epoch, pools BC k1/k2 coverage-weighted per epoch. NO application:
 * this produces the "running best fit" ledger, never a solve prior.
 */
export function recomputeRigProfile(deposits: ObservationDeposit[]): RigProfile | null {
    if (!deposits.length) return null;
    const first = deposits[0];
    const byEpoch = new Map<number, ObservationDeposit[]>();
    for (const d of deposits) {
        const arr = byEpoch.get(d.epoch) ?? [];
        arr.push(d);
        byEpoch.set(d.epoch, arr);
    }
    const epochs = [...byEpoch.keys()].sort((a, b) => a - b).map(e => poolEpoch(e, byEpoch.get(e)!));
    return {
        schema: WORKBENCH_SCHEMA_VERSION,
        rig_key: first.rig_key,
        key_quality: first.key_quality,
        body: first.body,
        lens: first.lens,
        body_serial: first.body_serial,
        n_deposits: deposits.length,
        current_epoch: epochs.length ? epochs[epochs.length - 1].epoch : 0,
        epochs,
        generated_at: new Date().toISOString(),
        application: 'NONE',
    };
}

// ─── RUNG-3 READ-BACK: POOLED SOLVE PRIOR (SOLVER_WORKBENCH_PRIOR, default OFF) ──
// The store is OBSERVATIONAL by default (application:'NONE'). This pure helper is
// the OPT-IN read seam for rung-3: given a rig's deposit log it returns a pooled
// distortion prior ONLY when the evidence is strong enough to seed a solve. It
// MUTATES NOTHING and never touches a solve itself — the SESSION (behind the
// SOLVER_WORKBENCH_PRIOR flag) decides whether to inject the returned k1/k2 as a
// LensDistortionResolution (provenance 'WORKBENCH_POOLED'). Returns null (no prior)
// unless the conservative agreement gate below passes, so the flag-OFF and
// thin/disagreeing-evidence paths are byte-identical to no prior at all.

/** Minimum agreeing measured-BC deposits before a pooled prior may seed a solve. */
export const WORKBENCH_PRIOR_MIN_DEPOSITS = 3;
/**
 * Magnitude-agreement bound: the agreeing set's population dispersion of k1,
 * normalized by |median k1|, must be at or below this. Conservative (≤50% spread)
 * — a rig whose per-frame k1 scatters more than half its own magnitude is NOT
 * consistent enough to seed the solve. Comparative bookkeeping, deliberately NOT
 * a SOLVER_* / GATES.md constant.
 */
export const WORKBENCH_PRIOR_MAX_REL_DISPERSION = 0.5;

export interface WorkbenchPooledPrior {
    /** Pooled MEDIAN k1 (robust to a single outlier fit). */
    k1: number;
    /** Pooled MEDIAN k2 across deposits that fitted k2; 0 when none did (radial k1-only). */
    k2: number;
    /** # measured-BC deposits that passed the agreement gate and were pooled. */
    n: number;
    /** Latest epoch the pool was drawn from (drift-forked epochs are never mixed). */
    epoch: number;
    /** Relative dispersion σ(k1)/|median k1| of the pooled set (transparency). */
    k1_rel_dispersion: number;
    /** Whether any pooled deposit actually fitted k2 (k2 is 0-by-default otherwise). */
    k2_fitted: boolean;
    /** Contributing receipt hashes — the prior CITES its sources (auditability). */
    receipt_hashes: string[];
}

/** Median of a non-empty numeric array (mean of the two middles for even length). */
function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pool a same-rig deposit log into a solve prior, or return null when the evidence
 * is too thin / inconsistent to seed a solve. Caller pre-filters to ONE rig (the
 * MODEL_ONLY key it is solving). PURE — reads deposits, mutates nothing.
 *
 * AGREEMENT GATE (all must hold; conservative by design):
 *   1. Draw from the LATEST epoch only — `assignEpoch` already forks a new epoch on
 *      a k1 sign-flip or >3σ departure, so a single epoch is by construction the
 *      rig's currently-consistent physics; mixing epochs would pool incompatible fits.
 *   2. ≥ WORKBENCH_PRIOR_MIN_DEPOSITS measured-BC deposits (bc.measured && k1 != null).
 *   3. UNANIMOUS SIGN — every k1 shares the sign of the median k1 (one opposite-sign
 *      fit vetoes the whole pool; a barrel-vs-pincushion disagreement is not "agreement").
 *   4. MAGNITUDE AGREEMENT — σ(k1)/|median k1| ≤ WORKBENCH_PRIOR_MAX_REL_DISPERSION.
 * On pass: pooled k1 = MEDIAN k1; pooled k2 = MEDIAN k2 over the k2-fitted subset
 * (0 when none fitted k2 → radial k1-only prior).
 */
export function poolWorkbenchPrior(deposits: ObservationDeposit[]): WorkbenchPooledPrior | null {
    if (!deposits.length) return null;
    let maxEpoch = 0;
    for (const d of deposits) if (d.epoch > maxEpoch) maxEpoch = d.epoch;
    const measured = deposits.filter(
        d => d.epoch === maxEpoch && d.bc.measured && d.bc.k1 != null && Number.isFinite(d.bc.k1),
    );
    if (measured.length < WORKBENCH_PRIOR_MIN_DEPOSITS) return null;

    const k1s = measured.map(d => d.bc.k1 as number);
    const k1med = median(k1s);
    if (!(k1med !== 0)) return null; // a zero-median prior is a no-op — nothing to seed

    // (3) unanimous sign vs the median (a single opposite-sign fit vetoes).
    const medSign = Math.sign(k1med);
    if (!k1s.every(v => Math.sign(v) === medSign)) return null;

    // (4) magnitude agreement — population dispersion normalized by |median|.
    const mean = k1s.reduce((s, v) => s + v, 0) / k1s.length;
    const variance = k1s.reduce((s, v) => s + (v - mean) ** 2, 0) / k1s.length;
    const relDispersion = Math.sqrt(variance) / Math.abs(k1med);
    if (relDispersion > WORKBENCH_PRIOR_MAX_REL_DISPERSION) return null;

    // k2 pooled only over deposits that actually fitted it (radial k1-only otherwise).
    const k2s = measured.map(d => d.bc.k2).filter((v): v is number => v != null && Number.isFinite(v));
    const k2fitted = k2s.length > 0;

    return {
        k1: k1med,
        k2: k2fitted ? median(k2s) : 0,
        n: measured.length,
        epoch: maxEpoch,
        k1_rel_dispersion: relDispersion,
        k2_fitted: k2fitted,
        receipt_hashes: measured.map(d => d.receipt_hash),
    };
}

// ─── RUNG-0 READ-BACK: IDENTITY-KEYED MEASURED PROFILE (SOLVER_IDENTITY_PROFILE) ─
// The optical-train fingerprint's payoff (Feb spec: "If a user previously
// calibrated this setup, it skips generic DB lookups"). Given a rig's deposit log
// and the frame's train hash, return the MEASURED distortion profile keyed to
// that EXACT train — the TOP resolver rung (rung-0), above the LENS_DB nominal.
//
// TWO TIERS (owner spec):
//   • placeholderTier = a REGISTERED, known/verified identity (the optical_train
//     placeholder registry) → a SINGLE measured deposit suffices (≥1). It is a
//     known setup; one verified calibration is trusted for it.
//   • else (auto-pooled) → keep the conservative ≥3-agreement gate
//     (poolWorkbenchPrior): an UNREGISTERED train earns a prior only on
//     multi-frame sign+magnitude agreement.
// PURE — reads deposits, mutates nothing. Returns null on any absence. Comparative
// bookkeeping, NOT a SOLVER_*/GATES.md constant.

/** A registered placeholder identity is trusted at a single measured deposit. */
export const IDENTITY_PROFILE_MIN_DEPOSITS_PLACEHOLDER = 1;

export interface WorkbenchIdentityProfile {
    /** Measured k1 (median across the train's measured deposits). */
    k1: number;
    /** Measured k2 (median over the k2-fitted subset; 0 when none fitted → radial). */
    k2: number;
    k2_fitted: boolean;
    /** The optical-train hash this profile is keyed to (auditability). */
    train_hash: string;
    /** # measured deposits for this train that were pooled. */
    n: number;
    /** Latest epoch drawn from (drift-forked epochs never mixed). */
    epoch: number;
    /** 'placeholder' (registered, ≥1) or 'auto_pool' (≥3 agreement). */
    tier: 'placeholder' | 'auto_pool';
    /** Contributing receipt hashes — the profile CITES its sources. */
    receipt_hashes: string[];
}

/**
 * Resolve the measured distortion profile keyed to a specific optical train.
 * `deposits` may be the whole store or pre-filtered to the rig — this filters to
 * `d.train_hash === trainHash` itself. `placeholderTier` marks a registered
 * identity (single-deposit trust); otherwise the ≥3 auto-pool gate applies.
 */
export function resolveIdentityProfile(
    deposits: ObservationDeposit[],
    trainHash: string,
    opts: { placeholderTier: boolean },
): WorkbenchIdentityProfile | null {
    if (!trainHash || !deposits.length) return null;
    const forTrain = deposits.filter(d => d.train_hash === trainHash);
    if (!forTrain.length) return null;

    if (!opts.placeholderTier) {
        // Unregistered train → the conservative auto-pool gate (≥3 + sign + magnitude).
        const pooled = poolWorkbenchPrior(forTrain);
        if (!pooled) return null;
        return {
            k1: pooled.k1, k2: pooled.k2, k2_fitted: pooled.k2_fitted,
            train_hash: trainHash, n: pooled.n, epoch: pooled.epoch,
            tier: 'auto_pool', receipt_hashes: pooled.receipt_hashes,
        };
    }

    // Registered placeholder identity → a single measured deposit suffices. Draw
    // from the latest epoch (drift-fork discipline), pool the MEDIAN k1/k2.
    let maxEpoch = 0;
    for (const d of forTrain) if (d.epoch > maxEpoch) maxEpoch = d.epoch;
    const measured = forTrain.filter(
        d => d.epoch === maxEpoch && d.bc.measured && d.bc.k1 != null && Number.isFinite(d.bc.k1),
    );
    if (measured.length < IDENTITY_PROFILE_MIN_DEPOSITS_PLACEHOLDER) return null;
    const k1s = measured.map(d => d.bc.k1 as number);
    const k1med = median(k1s);
    if (!(k1med !== 0)) return null; // a zero-median prior is a no-op — nothing to seed
    const k2s = measured.map(d => d.bc.k2).filter((v): v is number => v != null && Number.isFinite(v));
    const k2fitted = k2s.length > 0;
    return {
        k1: k1med,
        k2: k2fitted ? median(k2s) : 0,
        k2_fitted: k2fitted,
        train_hash: trainHash,
        n: measured.length,
        epoch: maxEpoch,
        tier: 'placeholder',
        receipt_hashes: measured.map(d => d.receipt_hash),
    };
}

// ─── STORAGE SEAM ─────────────────────────────────────────────────────────────
// Two impls live outside this module to keep it environment-neutral:
//   • browser  → workbench_storage_browser.ts (IndexedDB preferred, localStorage
//                fallback; size-bounded, oldest-first eviction)
//   • node     → tools/workbench/node_storage.ts (JSON-lines, injected in headless)
// Methods may be sync OR async; the deposit hook handles both (Node sync storage
// completes within the packaging call, browser async storage is fire-and-forget).

export interface WorkbenchStorage {
    /** Append one deposit row. */
    append(deposit: ObservationDeposit): void | Promise<void>;
    /** Deposits for a rig key (or ALL when omitted), oldest-first. */
    list(rigKey?: string): ObservationDeposit[] | Promise<ObservationDeposit[]>;
}

/**
 * In-memory storage — browser-safe, ephemeral. Used by tests and as a trivial
 * default; production browser/headless paths inject a persistent impl.
 */
export class MemoryWorkbenchStorage implements WorkbenchStorage {
    private rows: ObservationDeposit[] = [];
    append(deposit: ObservationDeposit): void { this.rows.push(deposit); }
    list(rigKey?: string): ObservationDeposit[] {
        return rigKey == null ? [...this.rows] : this.rows.filter(r => r.rig_key === rigKey);
    }
    /** test/introspection helper */
    all(): ObservationDeposit[] { return [...this.rows]; }
}
