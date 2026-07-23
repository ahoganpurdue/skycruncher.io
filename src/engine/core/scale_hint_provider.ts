/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCALE HINT-PROVIDER SEAM — per-IMAGE measured pixel-scale hints (content-hash keyed)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pre-solve seeding; produces a scalar plate-scale seed + provenance).
 *
 * SIBLING of core/optics_hint_provider.ts (untrusted-FL hints) and structurally
 * identical: a provider either supplies a labelled ASSUMPTION (`assumed: true`,
 * never a measurement OF THIS solve) or declines (`null`). The FIRST non-null
 * provider wins; the hint SEEDS the plate-scale search and is recorded so the
 * assumption is receipt-visible instead of silent (source / assumed / reason).
 *
 * WHY THIS EXISTS (owner law, 2026-07-09) — the 5D3 sample's EXIF/nominal-FL scale
 * prior is 25.7 % wrong (41.97 vs the oracle-measured 52.74 "/px). The fix is
 * PER-IMAGE, NOT per camera class: "people put different lenses on different
 * cameras, we can't globally assume Body 3 = Lens D." So a measured plate scale is
 * bound to the EXACT bytes it was measured on (content SHA-256) and delivered ONLY
 * to a frame whose bytes match. It NEVER propagates by body/model — that
 * propagation is gated on a distortion-profile (DBC/SIP/TPS) similarity bar and is
 * NOT IMPLEMENTED (design record: docs/OPTICAL_WORKBENCH_SCHEMA.md).
 *
 * WHERE THE MEASURED SCALE COMES FROM — a GOLD truth label
 * (tools/validation/truth/labels.json) carrying an INDEPENDENT astrometry.net solve
 * plus the frame's `content_sha256`. The table is INJECTED, mirroring
 * m1_ingestion/source_provenance.ts: the built-in provider list is EMPTY, so the
 * pure engine, BOTH pinned reference solves, and every BLIND gauntlet lane get
 * NOTHING by default — byte-identical, and still blind. A Node consumer that holds
 * the labels on disk OPTS IN by registering a content-hash provider built from
 * them (buildMeasuredScaleEntries → contentHashScaleHintProvider →
 * registerScaleHintProvider). The engine itself never reads the filesystem.
 *
 * INTEGRITY (nova ethos; CLAUDE.md LAWS 2 & 3):
 *  - A hint ACCELERATES the search — the math verify gate stays the SOLE arbiter,
 *    so a wrong/absent hint can only fail to verify, NEVER fabricate a "verified"
 *    answer. No gate or calibrated constant is touched.
 *  - HONEST-OR-ABSENT: every hint is `assumed: true` with a human `reason`; a label
 *    with no measured scale (null) declines.
 *  - OPT-IN: the default empty list keeps blind lanes blind unless a caller
 *    deliberately registers the truth-derived table.
 */

/**
 * A labelled scale ASSUMPTION delivered by a hint provider. `assumed` is the
 * literal `true` so a consumer can never treat it as a measurement of the current
 * solve, and `reason` explains the trigger in plain language.
 */
export interface ScaleHint {
    /** The seed plate scale (arcsec/px) handed to the scale search. */
    value_arcsec_per_px: number;
    /** Stable provider id (e.g. 'MEASURED_SCALE_CONTENT_HASH'). */
    source: string;
    /** ALWAYS true — a seed from a measurement made ELSEWHERE, not this solve (LAW 3). */
    assumed: true;
    /** Human-readable trigger explanation for the UI/receipt. */
    reason: string;
}

/** Context a provider inspects to decide whether (and what) to hint. */
export interface ScaleHintContext {
    /**
     * The ingest frame's content SHA-256 (hex) — the PER-IMAGE key. This is the
     * same hash m1_ingestion/source_provenance.ts keys on (sha-256 of the raw
     * ingest bytes). Absent/null ⇒ no content-hash provider can fire (honest-absent).
     */
    content_sha256?: string | null;
}

/**
 * A scale-hint provider: given the frame context, return a labelled assumption or
 * null (decline). Providers MUST self-gate and label their output `assumed: true`.
 */
export type ScaleHintProvider = (ctx: ScaleHintContext) => ScaleHint | null;

/** One per-IMAGE measured-scale binding (the injected table's element). */
export interface MeasuredScaleEntry {
    /** The frame's content SHA-256 (hex) — the per-IMAGE key. */
    content_sha256: string;
    /** The independently-measured plate scale, arcsec/px (> 0). */
    pixel_scale_arcsec: number;
    /** Optional frame id, for a human-legible reason string. */
    frame_id?: string;
    /** Optional provenance trail (which oracle/solve measured it). */
    provenance?: string;
}

/**
 * PROVIDER FACTORY — a content-hash-keyed provider closing over an injected table
 * of per-IMAGE measured scales. Fires ONLY when the context's `content_sha256`
 * exactly matches a table entry carrying a finite, positive measured scale;
 * otherwise declines (honest-absent). The match is byte-identity of the frame, so
 * a measured scale NEVER leaks to a different image (or a different lens on the
 * same body). Case-insensitive hex compare (sha digests differ only in case).
 */
export function contentHashScaleHintProvider(entries: MeasuredScaleEntry[]): ScaleHintProvider {
    const byHash = new Map<string, MeasuredScaleEntry>();
    for (const e of entries ?? []) {
        if (!e || typeof e.content_sha256 !== 'string' || !e.content_sha256) continue;
        const s = e.pixel_scale_arcsec;
        if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) continue;
        byHash.set(e.content_sha256.trim().toLowerCase(), e);
    }
    return (ctx) => {
        const key = (ctx.content_sha256 ?? '').toString().trim().toLowerCase();
        if (!key) return null;
        const hit = byHash.get(key);
        if (!hit) return null;
        const id = hit.frame_id ?? key.slice(0, 12);
        return {
            value_arcsec_per_px: hit.pixel_scale_arcsec,
            source: 'MEASURED_SCALE_CONTENT_HASH',
            assumed: true,
            reason:
                `content-hash (sha-256) match to a GOLD truth label (${id}): independently-measured `
                + `plate scale ${hit.pixel_scale_arcsec}"/px seeds the scale search`
                + (hit.provenance ? ` (${hit.provenance})` : '')
                + `. Per-IMAGE binding, NOT per camera body/model; hint accelerates search — the `
                + `verify gate remains the sole arbiter.`,
        };
    };
}

/**
 * The ordered provider list. First non-null wins. It is EMPTY by default: the pure
 * engine, both pinned reference solves, and every blind gauntlet lane therefore get
 * no hint (byte-identical, still blind). A Node consumer opts in by registering a
 * content-hash provider (built from labels.json via buildMeasuredScaleEntries).
 */
const SCALE_HINT_PROVIDERS: ScaleHintProvider[] = [];

/**
 * Register an additional scale-hint provider. `prepend` puts it ahead of the
 * existing providers so a higher-confidence hint is consulted first. Providers must
 * still self-gate and label their output `assumed: true` — the verify gate remains
 * the sole arbiter.
 */
export function registerScaleHintProvider(
    provider: ScaleHintProvider,
    opts?: { prepend?: boolean }
): void {
    if (opts?.prepend) SCALE_HINT_PROVIDERS.unshift(provider);
    else SCALE_HINT_PROVIDERS.push(provider);
}

/**
 * Remove ALL registered scale-hint providers, restoring the blind default (empty
 * list ⇒ no hint for anyone). Symmetric to setSourceProvenanceResolver(null); used
 * by tests and by a consumer tearing down an opt-in session.
 */
export function clearScaleHintProviders(): void {
    SCALE_HINT_PROVIDERS.length = 0;
}

/**
 * Query the ordered provider seam for a per-IMAGE scale hint. Returns the first
 * non-null labelled assumption, or null when every provider declines
 * (honest-absent). A throwing provider is skipped (never breaks the ladder).
 */
export function queryScaleHintProviders(ctx: ScaleHintContext): ScaleHint | null {
    for (const provider of SCALE_HINT_PROVIDERS) {
        try {
            const hint = provider(ctx);
            if (hint) return hint;
        } catch (err) {
            console.error('[ScaleHintProvider] provider threw; skipping:', err);
        }
    }
    return null;
}

/** A minimal view of a truth label carrying a per-IMAGE measured scale. */
export interface MeasuredScaleLabelLike {
    frame_id?: string;
    content_sha256?: string | null;
    pixel_scale_arcsec?: number | null;
    provenance_note?: string;
}

/**
 * PURE: distil the measured-scale table from parsed truth labels. Keeps ONLY labels
 * that carry BOTH a `content_sha256` AND a finite, positive measured pixel scale — a
 * center-only or hash-less label contributes nothing (honest). Takes PARSED JSON,
 * never reads disk: the engine stays filesystem-free; a Node caller reads
 * tools/validation/truth/labels.json and passes `.labels` in.
 */
export function buildMeasuredScaleEntries(labels: MeasuredScaleLabelLike[]): MeasuredScaleEntry[] {
    const out: MeasuredScaleEntry[] = [];
    if (!Array.isArray(labels)) return out;
    for (const l of labels) {
        if (!l || typeof l.content_sha256 !== 'string' || !l.content_sha256) continue;
        const s = l.pixel_scale_arcsec;
        if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) continue;
        out.push({
            content_sha256: l.content_sha256,
            pixel_scale_arcsec: s,
            frame_id: l.frame_id,
            provenance: l.provenance_note,
        });
    }
    return out;
}
