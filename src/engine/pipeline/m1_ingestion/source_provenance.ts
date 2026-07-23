/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOURCE PROVENANCE — where a frame's BYTES came from (origin audit trail)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure metadata — no coordinate math, no pixel ops).
 *
 * The intake fetcher (tools/overnight/fetch_intake.mjs) pulls external frames
 * (Google Drive file/folder, HTTP/archive.org) into the rotating lane and writes
 * a SIGNED provenance ledger row per file, keyed by content SHA-256
 * (test_results/overnight/intake_ledger.jsonl). This module carries that origin
 * knowledge THROUGH the pipeline so every downstream data product (receipt, ASDF,
 * FITS, community dump) can answer "where did this frame come from?".
 *
 * HONEST-OR-ABSENT (LAW 3): the origin is populated ONLY when the intake ledger
 * positively matches the file by content sha. Unknown ⇒ every field null, NEVER
 * fabricated. A plain browser upload (no ledger, no injected resolver) resolves to
 * null — which is why both pinned reference solves stay byte-identical (they are
 * bundled sample frames, not intake-fetched, so no ledger row matches on either
 * the browser OR the headless path).
 *
 * INJECTION SEAM: the pure engine never touches the filesystem. `matchIntakeProvenance`
 * is a pure function (sha + parsed ledger rows → provenance | null). The resolver
 * hook (`setSourceProvenanceResolver` / `resolveSourceProvenance`) defaults to null;
 * the overnight/community lane — which has the ledger on disk — injects a
 * ledger-backed resolver. The browser build and the headless API smoke inject
 * nothing, so ingest is a no-op there (null block, no I/O, byte-identical).
 */

/** Coarse origin channel of a frame's bytes. null = unknown (honest-or-absent). */
export type SourceOrigin = 'gdrive' | 'url' | 'local' | null;

/**
 * The source-provenance record carried on HardMetadata and surfaced as the
 * receipt's `source_provenance` block. Every field is nullable — a partial match
 * (e.g. a local-drop with no URI) fills what it knows and leaves the rest null.
 */
export interface SourceProvenance {
    /** Where the bytes were obtained: a Google Drive pull, an HTTP/archive URL,
     *  a local drop, or null when the origin is unknown. */
    origin: SourceOrigin;
    /** The resolved locator (download URL, source URL, or `gdrive:<id>`). null when
     *  unknown. */
    uri: string | null;
    /** ISO-8601 UTC timestamp the intake fetcher recorded when it pulled the file.
     *  null when the frame did not come through the fetcher. */
    fetched_at: string | null;
    /** The content SHA-256 the ledger row is keyed by (the match key). null when
     *  no ledger row matched. */
    intake_sha256: string | null;
}

/**
 * A shape-minimal view of one intake_ledger.jsonl row (fetch_intake.mjs schema
 * `skycruncher.intake.provenance/1`). Only the fields this mapper reads are typed;
 * the ledger carries more (identity, signature, http_status…) which we ignore.
 */
export interface IntakeLedgerRow {
    source?: { type?: string; url?: string; id?: string } | null;
    resolved_url?: string | null;
    sha256?: string | null;
    fetched_at?: string | null;
    [k: string]: unknown;
}

/** Map an intake ledger `source.type` → our coarse origin channel. Unknown/absent
 *  types map to null (honest — we do not guess). */
function originForType(t: string | undefined | null): SourceOrigin {
    if (t === 'gdrive_file' || t === 'gdrive_folder') return 'gdrive';
    if (t === 'http' || t === 'archive_org') return 'url';
    if (t === 'local' || t === 'local_drop') return 'local';
    return null;
}

/** Best URI for a matched row: the resolved download URL, else the declared source
 *  URL, else a `gdrive:<id>` locator, else null (never fabricated). */
function uriForRow(row: IntakeLedgerRow): string | null {
    if (typeof row.resolved_url === 'string' && row.resolved_url) return row.resolved_url;
    const s = row.source ?? undefined;
    if (s && typeof s.url === 'string' && s.url) return s.url;
    if (s && typeof s.id === 'string' && s.id) return `gdrive:${s.id}`;
    return null;
}

/**
 * PURE: find the ledger row whose sha256 matches the given content hash and map it
 * to a SourceProvenance. Returns null when no row matches — the frame's origin is
 * unknown (honest-or-absent; NEVER fabricated).
 */
export function matchIntakeProvenance(
    sha256Hex: string,
    ledgerRows: IntakeLedgerRow[]
): SourceProvenance | null {
    if (!sha256Hex || !Array.isArray(ledgerRows)) return null;
    const row = ledgerRows.find((r) => r && r.sha256 === sha256Hex);
    if (!row) return null;
    return {
        origin: originForType(row.source?.type),
        uri: uriForRow(row),
        fetched_at: typeof row.fetched_at === 'string' ? row.fetched_at : null,
        intake_sha256: typeof row.sha256 === 'string' ? row.sha256 : sha256Hex,
    };
}

/**
 * Injectable resolver hook. Given the raw ingest buffer, returns a SourceProvenance
 * or null. DEFAULT = null (browser + both pinned reference solves — no filesystem,
 * no ledger, no sha computed → byte-identical). The overnight/community lane sets a
 * ledger-backed resolver (compute sha → matchIntakeProvenance against the on-disk
 * ledger).
 */
export type SourceProvenanceResolver = (
    buffer: ArrayBuffer
) => Promise<SourceProvenance | null> | SourceProvenance | null;

let _resolver: SourceProvenanceResolver | null = null;

/** Install (or clear, with null) the process-wide ingest provenance resolver. */
export function setSourceProvenanceResolver(fn: SourceProvenanceResolver | null): void {
    _resolver = fn;
}

/**
 * Resolve the source provenance for an ingest buffer. Returns null when no resolver
 * is installed (the default — honest-absent, zero I/O). NEVER throws: a resolver
 * failure degrades to null so a provenance-lookup hiccup can never break ingest.
 */
export async function resolveSourceProvenance(buffer: ArrayBuffer): Promise<SourceProvenance | null> {
    if (!_resolver) return null;
    try {
        return (await _resolver(buffer)) ?? null;
    } catch {
        return null;
    }
}
