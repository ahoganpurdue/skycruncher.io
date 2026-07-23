/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OPTICS HINT-PROVIDER SEAM — untrusted-focal-length hints (labelled ASSUMPTIONS)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pre-solve seeding; produces a scalar FL seed + provenance).
 *
 * When the plate solver needs a focal length but the file's nominal FL is NOT
 * trustworthy (the electronics-less factory-default 50 mm signature), it asks
 * this seam for a HINT. A provider either supplies a labelled assumption
 * (`assumed: true`, never a measurement) or declines (`null`). The FIRST
 * non-null provider in the ordered list wins; the delivered hint REPLACES the
 * untrustworthy nominal FL and is recorded in the receipt (`optics_hints`) so
 * the assumption is receipt-visible instead of silent.
 *
 * WHY A SEAM (owner design): this is the future plug point for the reserved ML
 * hint-recommender. Hints SEED the search only — the math verify gate stays the
 * sole arbiter, so a provider can never bypass any gate: a wrong hint can only
 * fail to verify, never corrupt a "verified" answer. New providers append to
 * the ordered list (or `registerFocalLengthHintProvider`); no call-site edits.
 *
 * HONESTY (LAW 3): every hint is `assumed: true` with a human `reason`. It is
 * surfaced as an ASSUMPTION in the UI/receipt, never as a measured value.
 */

import { PIPELINE_CONSTANTS } from '../pipeline/constants/pipeline_config';

/**
 * Wide-field focal-length PRIOR (mm), applied ONLY as a last resort when an
 * electronics-less lens reports the camera's factory-default 50 mm AND the
 * user gave no focal-length hint. A SEED for the scale search, not a
 * measurement. (Canonical home; re-exported as `OpticsManager.WIDE_FIELD_FL_PRIOR_MM`
 * for the public API + calibration tests.)
 *
 * MISFIRE CAVEAT (ROADMAP 228b — the "original sin"): Canon logs exactly
 * 50 mm for ANY manual/adapted lens, so this prior is only *correct* for a
 * genuine wide-field frame (the bundled Rokinon-14 sample). A real 24/35/50/
 * 85 mm manual lens produces an IDENTICAL EXIF signature (50 mm / no lens /
 * f0) and cannot be told apart pre-solve. This is exactly why the value is a
 * SEED behind the verify gate and is now recorded as an ASSUMPTION in the
 * receipt rather than applied silently.
 */
export const WIDE_FIELD_FL_PRIOR_MM = 14;

/**
 * A labelled optics ASSUMPTION delivered by a hint provider. Never a
 * measurement — `assumed` is the literal `true` so a consumer can never treat
 * it as measured, and `reason` explains the trigger in plain language.
 */
export interface OpticsHint {
    /** The seed value (mm) handed to the scale search. */
    value_mm: number;
    /** Stable provider id (e.g. 'WIDE_FIELD_FL_PRIOR'). */
    source: string;
    /** ALWAYS true — this is an assumption, never a measurement (LAW 3). */
    assumed: true;
    /** Human-readable trigger explanation for the UI/receipt. */
    reason: string;
}

/** Context a provider inspects to decide whether (and what) to hint. */
export interface FocalLengthHintContext {
    /** The file's nominal EXIF focal length (mm), untrusted by definition here. */
    exif_focal_length: unknown;
    /** The (possibly placeholder/absent) lens model string. */
    lens_string: string;
    /** An explicit user focal-length hint, when present (providers defer to it). */
    explicit_hint_mm?: number | undefined;
}

/**
 * A focal-length hint provider: given the untrusted-FL context, return a
 * labelled assumption or null (decline). Providers MUST self-gate (flag /
 * condition) and are responsible for their own honest logging.
 */
export type FocalLengthHintProvider = (ctx: FocalLengthHintContext) => OpticsHint | null;

/**
 * PROVIDER #1 — the wide-field prior. Logic VERBATIM from the historical
 * OpticsManager.getEffectiveFocalLength inline block: fires only on the
 * electronics-less factory-default 50 mm signature, gated ON by
 * `OPTICS_WIDE_FIELD_PRIOR` (default ON; env/config-overridable OFF). Flag OFF
 * ⇒ returns null ⇒ the honest-absent ladder falls through to the nominal FL.
 */
function wideFieldFocalLengthPrior(ctx: FocalLengthHintContext): OpticsHint | null {
    // Flag OFF ⇒ decline (honest-absent fallthrough to the nominal FL).
    if (!PIPELINE_CONSTANTS.OPTICS_WIDE_FIELD_PRIOR) return null;
    // User evidence always wins (defensive; the caller already returns on a hint).
    if (ctx.explicit_hint_mm != null) return null;

    // 3-vs-2 discriminator: parseExif stores a TRUTHY 'Unknown Lens' placeholder
    // when no lens is reported, so a plain falsy check never fires in production.
    const lens = (ctx.lens_string ?? '').toString().trim();
    const lensIsUnknown = !lens || /^unknown( lens)?$/i.test(lens);

    if (ctx.exif_focal_length === 50 && lensIsUnknown) {
        // No lens electronics + factory-default 50 mm + no user hint: the nominal
        // FL is untrustworthy. Seed the scale search with the named wide-field
        // PRIOR — logged as an ASSUMPTION, never a measurement (verbatim message).
        console.log(
            `[OpticsManager] No lens electronics + factory-default 50mm EXIF and no user FL hint — ` +
            `seeding scale search with the ASSUMED wide-field prior ${WIDE_FIELD_FL_PRIOR_MM}mm ` +
            `(NOT measured; see ROADMAP 228b). Provide focal_length_hint_mm to override.`
        );
        return {
            value_mm: WIDE_FIELD_FL_PRIOR_MM,
            source: 'WIDE_FIELD_FL_PRIOR',
            assumed: true,
            reason: 'EXIF focal_length=50mm with placeholder/absent lens model '
                + '(electronics-less manual-lens signature); nominal FL untrusted',
        };
    }
    return null;
}

/**
 * The ordered provider list. First non-null wins. The wide-field prior is the
 * last-resort assumption; a future higher-priority provider (e.g. the ML
 * recommender) is prepended via registerFocalLengthHintProvider({prepend:true}).
 */
const FOCAL_LENGTH_HINT_PROVIDERS: FocalLengthHintProvider[] = [
    wideFieldFocalLengthPrior,
];

/**
 * Register an additional focal-length hint provider (the ML-recommender plug
 * point). `prepend` puts it ahead of the built-in wide-field prior so a
 * higher-confidence hint is consulted first. Providers must still self-gate and
 * label their output `assumed: true` — the verify gate remains the sole arbiter.
 */
export function registerFocalLengthHintProvider(
    provider: FocalLengthHintProvider,
    opts?: { prepend?: boolean }
): void {
    if (opts?.prepend) FOCAL_LENGTH_HINT_PROVIDERS.unshift(provider);
    else FOCAL_LENGTH_HINT_PROVIDERS.push(provider);
}

/**
 * Query the ordered provider seam for an untrusted-FL hint. Returns the first
 * non-null labelled assumption, or null when every provider declines
 * (honest-absent). A throwing provider is skipped (never breaks the ladder).
 */
export function queryFocalLengthHintProviders(ctx: FocalLengthHintContext): OpticsHint | null {
    for (const provider of FOCAL_LENGTH_HINT_PROVIDERS) {
        try {
            const hint = provider(ctx);
            if (hint) return hint;
        } catch (err) {
            console.error('[OpticsHintProvider] provider threw; skipping:', err);
        }
    }
    return null;
}
