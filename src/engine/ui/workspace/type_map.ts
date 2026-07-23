/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TYPE MAP — image-type → workspace auto-selection (with visible undo)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ingest classifies uploads as CR2 / FITS / ASDF. A Profile's `typeMap` maps a
 * type to a workspace id so the dashboard auto-selects on upload.
 *
 * UX LAW (owner, docs/WORKSPACE_DASHBOARD_DESIGN.md): an auto-switch is NEVER a
 * silent jump — it MUST surface a visible "switched to <X> — undo" affordance.
 * `resolveWorkspaceForUpload` therefore returns a rich RESULT OBJECT the host
 * renders as that affordance; nothing here touches the DOM.
 *
 * ASDF is a legal key TODAY even though the ASDF ingestor is a future engine
 * task — the mapping can be configured ahead of the reader landing.
 *
 * All functions are PURE. `applySwitch` / `undoSwitch` return a new Profile with
 * the active pointer moved; the host decides when to commit them.
 */

import {
    type Profile,
    type ImageType,
    IMAGE_TYPES,
    setActiveWorkspace,
} from './workspace_store';

/** Why a resolution did or did not switch — drives honest UI copy. */
export type SwitchReason =
    | 'switched'          // a mapping resolved to a different, existing workspace
    | 'no_mapping'        // type has no configured mapping
    | 'already_active'    // mapping points at the already-active workspace
    | 'stale_mapping';    // mapping points at a workspace that no longer exists

/**
 * The affordance object. `switched:true` ⇒ the host shows a
 * "Switched to <targetName> workspace — undo" toast; `previousWorkspaceId`
 * feeds the undo. `switched:false` ⇒ no visible jump (reason explains why).
 */
export interface SwitchResult {
    switched: boolean;
    imageType: ImageType;
    reason: SwitchReason;
    /** The workspace to activate (present only when switched). */
    targetWorkspaceId: string | null;
    targetWorkspaceName: string | null;
    /** The workspace that was active before — the undo target. */
    previousWorkspaceId: string;
}

/**
 * Resolve which workspace an upload of `imageType` should select. PURE — returns
 * the affordance object; does NOT mutate the profile (call {@link applySwitch}).
 */
export function resolveWorkspaceForUpload(profile: Profile, imageType: ImageType): SwitchResult {
    const previousWorkspaceId = profile.activeWorkspace;
    const base = { imageType, previousWorkspaceId, targetWorkspaceId: null, targetWorkspaceName: null };

    const mapped = profile.typeMap[imageType];
    if (mapped == null) return { ...base, switched: false, reason: 'no_mapping' };

    const target = profile.workspaces.find(w => w.id === mapped);
    if (!target) return { ...base, switched: false, reason: 'stale_mapping' };

    if (target.id === previousWorkspaceId) {
        return { ...base, switched: false, reason: 'already_active' };
    }
    return {
        switched: true,
        imageType,
        reason: 'switched',
        targetWorkspaceId: target.id,
        targetWorkspaceName: target.name,
        previousWorkspaceId,
    };
}

/** Commit a switch result (activates the target). No-op when not switched. */
export function applySwitch(profile: Profile, result: SwitchResult): Profile {
    if (!result.switched || !result.targetWorkspaceId) return profile;
    return setActiveWorkspace(profile, result.targetWorkspaceId);
}

/** Undo a committed switch (restores the previously-active workspace). */
export function undoSwitch(profile: Profile, result: SwitchResult): Profile {
    return setActiveWorkspace(profile, result.previousWorkspaceId);
}

/** Configure a type mapping. `workspaceId:null` clears it. */
export function setTypeMapping(
    profile: Profile,
    imageType: ImageType,
    workspaceId: string | null,
): Profile {
    if (workspaceId != null && !profile.workspaces.some(w => w.id === workspaceId)) return profile;
    return { ...profile, typeMap: { ...profile.typeMap, [imageType]: workspaceId } };
}

export function clearTypeMapping(profile: Profile, imageType: ImageType): Profile {
    return setTypeMapping(profile, imageType, null);
}

/** Type-guard for an unknown ingest label → a supported ImageType. */
export function asImageType(label: string): ImageType | null {
    return (IMAGE_TYPES as readonly string[]).includes(label) ? (label as ImageType) : null;
}
