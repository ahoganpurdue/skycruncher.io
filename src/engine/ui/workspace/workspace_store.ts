/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WORKSPACE STORE — Profile persistence (localStorage) + named-workspace CRUD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Persists the {@link Profile} (workspaces + type-map + active pointer) to
 * localStorage, mirroring the `diag_prefs` / widget-dock persistence pattern
 * (try/catch-wrapped, storage-unavailable safe, DEFAULT-OFF mount flag).
 *
 * Two hard guarantees (Law 3 honest-or-absent + never-crash):
 *   1. A VERSIONED schema field (`version`) for forward-compat. A profile whose
 *      version is unknown is treated as unreadable and falls back to the default.
 *   2. Corrupt / malformed / partial JSON NEVER throws to the caller — it always
 *      degrades to a sane {@link defaultProfile}.
 *
 * All CRUD helpers are PURE (`profile -> profile`); only `loadProfile` /
 * `saveProfile` / the enabled-flag getters touch storage.
 */

import {
    type LayoutNode,
    type WidgetId,
    makeLeaf,
    isSplit,
    isLeaf,
} from './layout_tree';

// ─── types (owner spec shape) ──────────────────────────────────────────────────

export type ImageType = 'CR2' | 'FITS' | 'ASDF';
export const IMAGE_TYPES: readonly ImageType[] = ['CR2', 'FITS', 'ASDF'];

export interface Workspace {
    id: string;
    name: string;
    /** One layout-tree root per window (v1 renders window[0]; multi-window is future). */
    windows: LayoutNode[];
    /** Per-widget UI prefs, opaque to the layout system. */
    widgetPrefs: Record<WidgetId, unknown>;
}

export interface Profile {
    /** Schema version — forward-compat gate (see WORKSPACE_SCHEMA_VERSION). */
    version: number;
    workspaces: Workspace[];
    /** Image-type → workspace id (auto-select on upload). Null = unmapped. */
    typeMap: Record<ImageType, string | null>;
    /** Currently active workspace id (should reference an existing workspace). */
    activeWorkspace: string;
}

// ─── constants ─────────────────────────────────────────────────────────────────

export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_STORAGE_KEY = 'skycruncher.workspace.profile';
/** DEFAULT-OFF mount flag (mirrors `skycruncher.widgets.dock`). */
export const WORKSPACE_ENABLED_STORAGE_KEY = 'skycruncher.workspace.enabled';

let __wsCounter = 0;
function nextWorkspaceId(): string { __wsCounter += 1; return `wsp-${__wsCounter}`; }
/** Reset the workspace-id counter — TEST HOOK ONLY. */
export function __resetWorkspaceIds(): void { __wsCounter = 0; }

// ─── defaults ──────────────────────────────────────────────────────────────────

function emptyTypeMap(): Record<ImageType, string | null> {
    return { CR2: null, FITS: null, ASDF: null };
}

/** A single-window workspace holding one leaf with the given tabs. */
export function makeWorkspace(name: string, tabs: WidgetId[] = [], opts?: { id?: string }): Workspace {
    return {
        id: opts?.id ?? nextWorkspaceId(),
        name,
        windows: [makeLeaf(tabs)],
        widgetPrefs: {},
    };
}

/**
 * A sane default Profile: one "Default" workspace showing the solve-summary
 * widget, nothing type-mapped, active = the default workspace. This is the
 * fallback the store returns whenever persisted state is missing or corrupt.
 */
export function defaultProfile(): Profile {
    // Fixed ids ⇒ defaultProfile() is DETERMINISTIC (idempotent): every call
    // produces a deep-equal profile, so the corrupt-state fallback compares equal.
    const ws: Workspace = {
        id: 'wsp-default',
        name: 'Default',
        windows: [makeLeaf(['solve_summary'], { id: 'leaf-default' })],
        widgetPrefs: {},
    };
    return {
        version: WORKSPACE_SCHEMA_VERSION,
        workspaces: [ws],
        typeMap: emptyTypeMap(),
        activeWorkspace: ws.id,
    };
}

// ─── validation (corrupt-state fallback) ────────────────────────────────────────

function isValidLayoutNode(n: unknown): n is LayoutNode {
    if (!n || typeof n !== 'object') return false;
    const node = n as LayoutNode;
    if (isLeaf(node)) {
        return typeof node.id === 'string'
            && Array.isArray(node.tabs)
            && node.tabs.every(t => typeof t === 'string')
            && typeof node.active === 'number';
    }
    if (isSplit(node)) {
        return typeof node.id === 'string'
            && (node.direction === 'row' || node.direction === 'col')
            && Array.isArray(node.sizes)
            && Array.isArray(node.children)
            && node.sizes.length === node.children.length
            && node.children.every(isValidLayoutNode);
    }
    return false;
}

function isValidWorkspace(w: unknown): w is Workspace {
    if (!w || typeof w !== 'object') return false;
    const ws = w as Workspace;
    return typeof ws.id === 'string'
        && typeof ws.name === 'string'
        && Array.isArray(ws.windows)
        && ws.windows.length > 0
        && ws.windows.every(isValidLayoutNode)
        && !!ws.widgetPrefs && typeof ws.widgetPrefs === 'object';
}

/**
 * Structural validity of a parsed profile. Rejects unknown schema versions
 * (forward-compat gate) and any shape mismatch — the caller then falls back to
 * the default rather than trusting partial data.
 */
export function isValidProfile(p: unknown): p is Profile {
    if (!p || typeof p !== 'object') return false;
    const prof = p as Profile;
    if (prof.version !== WORKSPACE_SCHEMA_VERSION) return false;    // forward-compat gate
    if (!Array.isArray(prof.workspaces) || prof.workspaces.length === 0) return false;
    if (!prof.workspaces.every(isValidWorkspace)) return false;
    if (!prof.typeMap || typeof prof.typeMap !== 'object') return false;
    for (const t of IMAGE_TYPES) {
        const v = (prof.typeMap as Record<string, unknown>)[t];
        if (v !== null && typeof v !== 'string') return false;
    }
    if (typeof prof.activeWorkspace !== 'string') return false;
    // active pointer must reference an existing workspace
    if (!prof.workspaces.some(w => w.id === prof.activeWorkspace)) return false;
    return true;
}

// ─── storage I/O (never throws) ─────────────────────────────────────────────────

/**
 * Load the persisted profile. ANY failure — no key, bad JSON, wrong shape,
 * unknown version, storage unavailable — degrades to {@link defaultProfile}.
 * Never throws.
 */
export function loadProfile(): Profile {
    try {
        const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
        if (raw == null) return defaultProfile();
        const parsed = JSON.parse(raw);
        return isValidProfile(parsed) ? parsed : defaultProfile();
    } catch {
        return defaultProfile();
    }
}

/** Persist the profile. Storage-unavailable safe (silent no-op on failure). */
export function saveProfile(profile: Profile): void {
    try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(profile)); }
    catch { /* storage unavailable */ }
}

// ─── mount flag (DEFAULT OFF; mirrors the dock flag) ────────────────────────────

/** Is the workspace host mounted at all? DEFAULT OFF ⇒ host renders nothing. */
export function getWorkspaceEnabled(): boolean {
    try { return localStorage.getItem(WORKSPACE_ENABLED_STORAGE_KEY) === '1'; }
    catch { return false; }
}

export function setWorkspaceEnabled(on: boolean): void {
    try { localStorage.setItem(WORKSPACE_ENABLED_STORAGE_KEY, on ? '1' : '0'); }
    catch { /* storage unavailable */ }
}

// ─── named-workspace CRUD (pure: profile -> profile) ────────────────────────────

export function getActiveWorkspace(profile: Profile): Workspace | null {
    return profile.workspaces.find(w => w.id === profile.activeWorkspace) ?? null;
}

/** Add a new named workspace and make it active. */
export function createWorkspace(
    profile: Profile,
    name: string,
    opts?: { tabs?: WidgetId[]; id?: string; activate?: boolean },
): Profile {
    const ws = makeWorkspace(name, opts?.tabs ?? [], { id: opts?.id });
    const activate = opts?.activate ?? true;
    return {
        ...profile,
        workspaces: [...profile.workspaces, ws],
        activeWorkspace: activate ? ws.id : profile.activeWorkspace,
    };
}

export function renameWorkspace(profile: Profile, id: string, name: string): Profile {
    return {
        ...profile,
        workspaces: profile.workspaces.map(w => (w.id === id ? { ...w, name } : w)),
    };
}

/**
 * Delete a workspace. Refuses to delete the last one (a profile always has ≥1).
 * Reassigns `activeWorkspace` and drops any type-map entries pointing at it.
 */
export function deleteWorkspace(profile: Profile, id: string): Profile {
    if (profile.workspaces.length <= 1) return profile;              // never zero
    if (!profile.workspaces.some(w => w.id === id)) return profile;
    const workspaces = profile.workspaces.filter(w => w.id !== id);
    const activeWorkspace = profile.activeWorkspace === id ? workspaces[0].id : profile.activeWorkspace;
    const typeMap = { ...profile.typeMap };
    for (const t of IMAGE_TYPES) if (typeMap[t] === id) typeMap[t] = null;
    return { ...profile, workspaces, activeWorkspace, typeMap };
}

/** Switch the active workspace (no-op if the id is unknown). */
export function setActiveWorkspace(profile: Profile, id: string): Profile {
    if (!profile.workspaces.some(w => w.id === id)) return profile;
    return { ...profile, activeWorkspace: id };
}

/** Replace a workspace via an updater (e.g. after a layout-tree transform). */
export function updateWorkspace(
    profile: Profile,
    id: string,
    updater: (w: Workspace) => Workspace,
): Profile {
    return {
        ...profile,
        workspaces: profile.workspaces.map(w => (w.id === id ? updater(w) : w)),
    };
}

/** Replace the layout tree of a workspace's first (v1) window. */
export function setActiveWindowLayout(profile: Profile, id: string, root: LayoutNode): Profile {
    return updateWorkspace(profile, id, w => ({
        ...w,
        windows: w.windows.length ? [root, ...w.windows.slice(1)] : [root],
    }));
}
