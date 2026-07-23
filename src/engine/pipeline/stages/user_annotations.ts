/**
 * ═══════════════════════════════════════════════════════════════════════════
 * USER ANNOTATIONS — observer testimony (additive receipt block)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER — this is TEXT, not a measurement. It never enters the solve.
 *
 * DOCTRINE (load-bearing): user_annotations is TESTIMONY. Every field is a
 * free-text STRING and is NEVER parsed into a number, a knob, or any solve input.
 * It is kept structurally SEPARATE from `SoftMetadata` (types/schema.ts), which
 * DOES feed the physics/force model (is_stacked, tracking_mount, filter_type,
 * bortle_class-as-number, …). SoftMetadata influences the solve; annotations
 * describe it after the fact. Do NOT wire a field of this block into any solve /
 * detection / verification path — that would launder testimony into evidence.
 *
 * Honest-or-absent (LAW 3): when the observer supplied nothing, the block is
 * `null` — never an empty-string skeleton pretending to be data. This keeps the
 * pinned reference solves byte-identical (their receipts carry `user_annotations:
 * null`), and it means a consumer that sees a non-null block knows a human (or an
 * explicitly-confirmed MCP draft) actually said something.
 *
 * Provenance:
 *   - 'user'         — typed directly by the observer in the export UI.
 *   - 'mcp_assisted' — drafted by the MCP `draft_annotation` tool from prose and
 *                      then EXPLICITLY CONFIRMED by the user before it was applied
 *                      to the session. The MCP tool NEVER writes a session itself;
 *                      the UI confirm is the only gate that promotes a draft.
 */

/** The five free-text testimony fields. All optional at capture; STRING only. */
export type AnnotationField =
    | 'description'
    | 'location_text'
    | 'sky_bortle_text'
    | 'rig_notes'
    | 'session_issues';

export type AnnotationProvenance = 'user' | 'mcp_assisted';

/** The additive receipt block. Every field is a string (never a parsed value). */
export interface UserAnnotations {
    /** Free prose describing the target / intent of the session. */
    description: string;
    /** Human location text (e.g. "Anza-Borrego, CA"). NOT parsed into GPS/solve. */
    location_text: string;
    /** Sky quality as the observer described it (e.g. "Bortle 4, some haze"). NOT
     *  parsed into the numeric bortle_class that SoftMetadata feeds to the model. */
    sky_bortle_text: string;
    /** Rig / optical-train notes in the observer's words. NOT parsed into optics. */
    rig_notes: string;
    /** Anything that went wrong (clouds, wind, focus drift, satellites, …). */
    session_issues: string;
    provenance: AnnotationProvenance;
    /** ISO-8601 capture time. */
    captured_at: string;
}

const FIELDS: AnnotationField[] = [
    'description',
    'location_text',
    'sky_bortle_text',
    'rig_notes',
    'session_issues',
];

/** Coerce any input to a trimmed string (null/undefined/number → best-effort string). */
function toText(v: unknown): string {
    if (v == null) return '';
    return String(v).trim();
}

function normalizeProvenance(p: unknown): AnnotationProvenance {
    return p === 'mcp_assisted' ? 'mcp_assisted' : 'user';
}

/**
 * Normalize raw capture fields into a `UserAnnotations` block, or `null` when the
 * observer supplied nothing (honest-or-absent). Pure: pass `capturedAt` explicitly
 * for deterministic output (tests, headless); it defaults to now.
 *
 * The returned block is ALWAYS fully string-typed with the same key set — never a
 * partial object — so a consumer reads a uniform shape or an explicit null.
 */
export function buildUserAnnotations(
    fields: Partial<Record<AnnotationField, string | null | undefined>> | null | undefined,
    meta?: { provenance?: AnnotationProvenance; capturedAt?: string },
): UserAnnotations | null {
    if (!fields) return null;
    const text: Record<AnnotationField, string> = {
        description: toText(fields.description),
        location_text: toText(fields.location_text),
        sky_bortle_text: toText(fields.sky_bortle_text),
        rig_notes: toText(fields.rig_notes),
        session_issues: toText(fields.session_issues),
    };
    // Honest-absent: nothing to record if every field is empty.
    const anyContent = FIELDS.some(f => text[f].length > 0);
    if (!anyContent) return null;

    return {
        ...text,
        provenance: normalizeProvenance(meta?.provenance),
        captured_at: typeof meta?.capturedAt === 'string' && meta.capturedAt.length > 0
            ? meta.capturedAt
            : new Date().toISOString(),
    };
}
