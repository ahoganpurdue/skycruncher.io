/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LEGACY localStorage KEY MIGRATION — one-time `astrologic.*` → `skycruncher.*`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The SkyCruncher rename (LAW 6) moved every persisted UI-preference key from the
 * `astrologic` namespace to `skycruncher` (widget dock / weight / enabled, the
 * replay dashboard + layout, the solve-queue pane, and the shared persist base).
 *
 * CONTRACT (copy-on-read, non-destructive): for every stored `astrologic`-prefixed
 * key whose `skycruncher` counterpart is ABSENT, copy the value across verbatim
 * (envelope + schema-version tag travel intact). The legacy key is NEVER deleted,
 * so a downgrade still finds its prefs and a re-run is idempotent. Runs once at
 * boot, before any component reads a preference.
 *
 * HEADLESS-SAFE: the only ambient dependency is `localStorage`; every access is
 * try/caught, so this is a no-op under Node / SSR / a storage-disabled browser.
 */

const LEGACY_PREFIX = 'astrologic';
const NEW_PREFIX = 'skycruncher';

/**
 * One-time migration of legacy `astrologic*` persisted keys to the `skycruncher*`
 * namespace. Copy-only (old keys preserved), idempotent, never throws.
 */
export function migrateLegacyPersistKeys(): void {
    try {
        if (typeof localStorage === 'undefined' || localStorage == null) return;
        const pending: Array<[string, string]> = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k == null) continue;
            // Match the base namespace exactly OR any `astrologic.`-prefixed key.
            if (k !== LEGACY_PREFIX && !k.startsWith(LEGACY_PREFIX + '.')) continue;
            const newKey = NEW_PREFIX + k.slice(LEGACY_PREFIX.length);
            if (localStorage.getItem(newKey) != null) continue; // new value already set — do not clobber
            const val = localStorage.getItem(k);
            if (val != null) pending.push([newKey, val]);
        }
        // Collected first (avoid mutating storage while iterating its index).
        for (const [newKey, val] of pending) localStorage.setItem(newKey, val);
    } catch {
        /* storage unavailable — skip silently */
    }
}
