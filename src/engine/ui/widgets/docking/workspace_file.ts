/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKYWORKSPACE FILE — export/import envelope for the docking Profile (v0)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A workspace is the arrangement of panels on the dashboard (which widgets are
 * docked, where, how they are split). We already persist that in localStorage as
 * **Profile schema v2** — the dockview `toJSON()` blob wrapped in a `{ v, data }`
 * envelope (`docking_store.ts`, `widget_persist.ts`). This module moves that same
 * object to and from a shareable `.skyworkspace.json` file — same-user / same-
 * trust sharing only (WIDGET_ECOSYSTEM_DESIGN_2026-07-22 §2). It is a NEW file
 * format: it touches NO receipt / schema / engine surface.
 *
 * The file wrapper:
 *   {
 *     skyworkspace_version: '1.0.0',      // THIS file format's version
 *     kind: 'skycruncher.workspace',      // cheap identity guard
 *     app_version: '1.1.0',               // provenance ONLY, never a gate
 *     exported_at: '2026-07-22T…Z',
 *     profile: { v: 2, data: { layout } } // the EXACT Profile-v2 on-disk shape
 *   }
 *
 * VALIDATION REUSE (task §2, LAW 3 honest-or-absent): import does NOT introduce a
 * second layout validator. The inner `profile` is the identical `{ v, data }`
 * envelope the docking store persists, so import checks it with the store's OWN
 * primitives — `DOCKING_SCHEMA_VERSION` for the version gate and `isDockingData`
 * for the structural gate (both imported from `docking_store`). A foreign /
 * too-new / malformed file is a LOUD, itemised rejection — never a silent partial
 * apply (mirrors the store's loud-reset contract, `docking_store.ts:11-16`).
 *
 * PURE: no Tauri, no DOM, no localStorage. The platform file I/O lives in the
 * `workspace_io.ts` seam; this module is fully unit-testable headlessly.
 *
 * Ledger: RENDER PLANE — display-surface persistence only.
 */

import type { SerializedDockview } from 'dockview-core';
import { DOCKING_SCHEMA_VERSION, isDockingData, type DockingData } from './docking_store';

/** This FILE FORMAT's version (independent of the inner Profile schema version). */
export const SKYWORKSPACE_VERSION = '1.0.0';

/** Identity discriminator carried in every envelope (cheap foreign-file guard). */
export const SKYWORKSPACE_KIND = 'skycruncher.workspace';

/** Canonical file extension / suggested filename for the native save dialog. */
export const SKYWORKSPACE_EXT = 'skyworkspace.json';
export const SKYWORKSPACE_DEFAULT_FILENAME = `dashboard.${SKYWORKSPACE_EXT}`;

/**
 * The `.skyworkspace.json` envelope. `profile` is the docking store's persisted
 * shape verbatim (`PersistEnvelope<DockingData>`), so a round-trip is byte-exact
 * and import can reuse the store's version + structural gates.
 */
export interface SkyworkspaceEnvelope {
    skyworkspace_version: string;
    kind: typeof SKYWORKSPACE_KIND;
    /** Provenance only — recorded, NEVER gated on. */
    app_version: string;
    /** ISO-8601 export timestamp — provenance only. */
    exported_at: string;
    /** The Profile-v2 on-disk envelope: { v, data: { layout } }. */
    profile: { v: number; data: DockingData };
}

/** Why an envelope was rejected (drives the LOUD honest error message). */
export type WorkspaceRejectReason =
    | 'parse_error'          // JSON.parse threw
    | 'not_object'           // parsed to a non-object
    | 'wrong_kind'           // missing / wrong `kind` discriminator
    | 'unsupported_version'  // skyworkspace_version ≠ SKYWORKSPACE_VERSION
    | 'profile_version'      // inner profile.v ≠ the running Profile schema version
    | 'malformed_profile';   // profile.data failed the store's isDockingData gate

export type WorkspaceParseResult =
    | { ok: true; layout: SerializedDockview; envelope: SkyworkspaceEnvelope }
    | { ok: false; reason: WorkspaceRejectReason; detail: string };

/**
 * Build a `.skyworkspace.json` envelope from the current dockview layout. The
 * layout comes from `api.toJSON()`; `appVersion` is provenance only. `now` is
 * injectable for deterministic tests.
 */
export function buildWorkspaceEnvelope(
    layout: SerializedDockview,
    opts: { appVersion: string; now?: Date },
): SkyworkspaceEnvelope {
    return {
        skyworkspace_version: SKYWORKSPACE_VERSION,
        kind: SKYWORKSPACE_KIND,
        app_version: opts.appVersion,
        exported_at: (opts.now ?? new Date()).toISOString(),
        // The EXACT Profile-v2 persisted shape — { v, data:{layout} } — so a
        // round-trip through the file equals a round-trip through localStorage.
        profile: { v: DOCKING_SCHEMA_VERSION, data: { layout } },
    };
}

/** Serialize an envelope to the on-disk JSON text (pretty-printed, human-diffable). */
export function serializeWorkspace(envelope: SkyworkspaceEnvelope): string {
    return JSON.stringify(envelope, null, 2);
}

/**
 * Parse + validate an already-parsed object (the reusable core). Applies, in
 * order: identity (`kind`) → file-format version → inner Profile version → inner
 * structural gate. The last two REUSE the docking store's own primitives
 * (`DOCKING_SCHEMA_VERSION`, `isDockingData`) — no second validator. Any failure
 * returns `{ ok:false }` with a reason + human detail; never throws.
 */
export function parseWorkspaceObject(parsed: unknown): WorkspaceParseResult {
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'not_object', detail: 'File is not a workspace object.' };
    }
    const env = parsed as Partial<SkyworkspaceEnvelope>;
    if (env.kind !== SKYWORKSPACE_KIND) {
        return {
            ok: false,
            reason: 'wrong_kind',
            detail: `Not a SkyCruncher workspace file (kind=${JSON.stringify(env.kind)}).`,
        };
    }
    if (env.skyworkspace_version !== SKYWORKSPACE_VERSION) {
        return {
            ok: false,
            reason: 'unsupported_version',
            detail: `Unsupported workspace file version ${JSON.stringify(env.skyworkspace_version)} — this build reads ${SKYWORKSPACE_VERSION}.`,
        };
    }
    const profile = env.profile;
    if (!profile || typeof profile !== 'object' || profile.v !== DOCKING_SCHEMA_VERSION) {
        return {
            ok: false,
            reason: 'profile_version',
            detail: `Workspace layout schema v${(profile && (profile as { v?: unknown }).v) ?? '?'} does not match this build's v${DOCKING_SCHEMA_VERSION}.`,
        };
    }
    if (!isDockingData(profile.data)) {
        return {
            ok: false,
            reason: 'malformed_profile',
            detail: 'Workspace layout is malformed (missing grid/panels).',
        };
    }
    return { ok: true, layout: profile.data.layout, envelope: env as SkyworkspaceEnvelope };
}

/** Parse + validate raw file TEXT. JSON errors degrade to a LOUD reason, never a throw. */
export function parseWorkspace(text: string): WorkspaceParseResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { ok: false, reason: 'parse_error', detail: `File is not valid JSON: ${(err as Error).message}` };
    }
    return parseWorkspaceObject(parsed);
}
