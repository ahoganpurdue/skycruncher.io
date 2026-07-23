/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VERSIONED UI PERSISTENCE — one namespaced, migratable localStorage surface
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ★ dashboard program's "one coherent surface" (A4 item 3 + 4): every
 * persisted UI-state blob for the widget dock AND the replay dashboard flows
 * through here, wrapped in a `{ v, data }` envelope, so a future schema change
 * can migrate or cleanly INVALIDATE a stale blob instead of crashing on it.
 *
 * CONTRACT (honest-or-absent, LAW 3):
 *   - read  → the stored `data` when the envelope version matches AND (optional)
 *             validator passes; otherwise `null` (caller falls back to default).
 *             A version mismatch is a silent invalidation, never a half-migrated
 *             object and never a throw.
 *   - write → stamps the current version. Best-effort (quota / no-storage → no-op).
 *
 * PURE-ish: the only ambient dependency is the `localStorage` global, and every
 * access is try/caught, so this is headless/Node-safe (returns null there).
 * No React, no DOM beyond storage.
 */

/** Shared key namespace for every widget/dashboard persisted preference. */
export const PERSIST_NAMESPACE = 'skycruncher';
// (A4 wave: shared versioned-persist surface for dock + replay dashboard.)

/** The on-disk envelope: a schema version tag around the payload. */
export interface PersistEnvelope<T> {
    /** Schema version — bump to invalidate every stored blob for this key. */
    v: number;
    /** The versioned payload. */
    data: T;
}

/**
 * Read a versioned blob. Returns the payload only when the stored envelope's
 * version equals `version` and the optional `validate` guard accepts the data;
 * otherwise `null` (missing key, stale version, corrupt JSON, or failed guard).
 */
export function readVersioned<T>(
    key: string,
    version: number,
    validate?: (data: unknown) => data is T,
): T | null {
    try {
        const raw = localStorage.getItem(key);
        if (raw == null) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        const env = parsed as Partial<PersistEnvelope<unknown>>;
        if (env.v !== version) return null;          // stale schema ⇒ invalidate cleanly
        const data = env.data;
        if (validate && !validate(data)) return null; // structural guard failed ⇒ invalidate
        return data as T;
    } catch {
        return null;                                   // corrupt / no storage ⇒ default
    }
}

/** Write a payload under the given schema version. Best-effort (never throws). */
export function writeVersioned<T>(key: string, version: number, data: T): void {
    try {
        const env: PersistEnvelope<T> = { v: version, data };
        localStorage.setItem(key, JSON.stringify(env));
    } catch {
        /* storage unavailable / quota exceeded — best-effort persistence */
    }
}

/** Remove a persisted key (explicit reset / migration drop). Never throws. */
export function clearKey(key: string): void {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
}
