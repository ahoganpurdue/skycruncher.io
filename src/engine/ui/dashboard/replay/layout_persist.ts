/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAYOUT PERSISTENCE — versioned save/restore for the ★ Replay Dashboard shell
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A4 item 3. Routes the dashboard's pane/tab LayoutNode tree through the shared
 * versioned-persist surface (`widget_persist`), so a future layout-schema change
 * MIGRATES or cleanly INVALIDATES a stale blob (→ falls back to the default)
 * instead of restoring a broken tree. A structural guard also rejects a
 * hand-tampered / partial blob at the same version.
 *
 * PURE + node-testable (only the localStorage global, all guarded).
 */

import { readVersioned, writeVersioned } from '../../widgets/widget_persist';
import type { LayoutNode } from './layout_tree';

/** Namespaced, versioned key for the persisted layout tree. */
export const LAYOUT_STORAGE_KEY = 'skycruncher.replay.layout';
/** Bump to invalidate every stored layout blob (LayoutNode schema migration). */
export const LAYOUT_SCHEMA_VERSION = 1;

/**
 * Structural guard for a persisted layout tree (recursive). A well-formed node
 * is a leaf (id + string tabs + numeric active) or a split (id + row/col + numeric
 * sizes + ≥1 valid children). Total (never throws) and defensive against a stale
 * or hand-edited blob.
 */
export function isLayoutNode(x: unknown): x is LayoutNode {
    if (x == null || typeof x !== 'object') return false;
    const n = x as Record<string, unknown>;
    if (n.type === 'leaf') {
        return typeof n.id === 'string'
            && Array.isArray(n.tabs) && (n.tabs as unknown[]).every(t => typeof t === 'string')
            && typeof n.active === 'number';
    }
    if (n.type === 'split') {
        return typeof n.id === 'string'
            && (n.direction === 'row' || n.direction === 'col')
            && Array.isArray(n.sizes) && (n.sizes as unknown[]).every(s => typeof s === 'number')
            && Array.isArray(n.children) && (n.children as unknown[]).length > 0
            && (n.children as unknown[]).every(isLayoutNode);
    }
    return false;
}

/** Restore the persisted layout, or `fallback` on absence / stale version / corruption. */
export function loadLayout(fallback: LayoutNode): LayoutNode {
    return readVersioned<LayoutNode>(LAYOUT_STORAGE_KEY, LAYOUT_SCHEMA_VERSION, isLayoutNode) ?? fallback;
}

/** Persist the layout under the current schema version (best-effort, never throws). */
export function saveLayout(node: LayoutNode): void {
    writeVersioned(LAYOUT_STORAGE_KEY, LAYOUT_SCHEMA_VERSION, node);
}
