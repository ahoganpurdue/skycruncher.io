/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WORKSPACE HOST — v1 layout-tree renderer (render layer only; UI ledger)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Renders a {@link LayoutNode} tree: recursive Splits (CSS flex, `sizes` honored)
 * with a tab-bar per Leaf and the active widget rendered through the EXISTING
 * phase-1 registry (`widgets/registry.ts`, consumed READ-ONLY — WIDGETS + the
 * frame-level NOT-MEASURED contract). This module NEVER edits the registry or
 * the dock; if it needs an export the registry lacks, that is a flag-up, not an
 * edit.
 *
 * DEFAULT OFF + UNMOUNTED: gated behind the `skycruncher.workspace.enabled`
 * localStorage flag (mirrors the dock flag). When off it returns null — ZERO DOM,
 * no hooks on the off-path (hooks-rules safe). Nothing in the app mounts this yet;
 * wiring it in is a one-line, owner-review JSX add (see the note at the bottom).
 *
 * KEYBOARD GRAMMAR — v1 SIMPLIFICATION (documented): the owner spec is
 * "hold a tab label + Arrow = split in that direction". v1 implements the
 * equivalent as FOCUS + Arrow: Tab-focus a tab label, press Arrow ↑/↓/←/→, and
 * the leaf splits in that direction (`directionForArrow`). The hold-to-drag
 * ergonomic is a v2 concern (drag polish is the hard 20% of docking UIs — the
 * design doc calls it out explicitly). The underlying transform is identical.
 *
 * Style: @theme design tokens ONLY (tailwind token classes — `space-*`, `line`,
 * `text-*`, `accent-*`), matching WidgetDock chrome; no bespoke colors, both
 * themes via the shared tokens.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
    type LayoutNode,
    type LeafNode,
    type SplitNode,
    isSplit,
    directionForArrow,
    splitLeaf,
    setActiveTab,
    closeTab,
} from './layout_tree';
import {
    type Profile,
    type ImageType,
    loadProfile,
    saveProfile,
    getWorkspaceEnabled,
    getActiveWorkspace,
    setActiveWindowLayout,
} from './workspace_store';
import {
    type SwitchResult,
    resolveWorkspaceForUpload,
    applySwitch,
    undoSwitch,
} from './type_map';
import {
    WIDGETS,
    type WidgetManifest,
    type WidgetReceipt,
    type WidgetEvents,
} from '../widgets/registry';

const NOT_MEASURED = 'NOT MEASURED';

/** id → manifest lookup, built once over the registry (read-only). */
const WIDGET_BY_ID: Map<string, WidgetManifest> = new Map(WIDGETS.map(w => [w.id, w]));

export interface WorkspaceHostProps {
    /** The wizard receipt (buildReceipt output). Pure read by widget selectors. */
    receipt: WidgetReceipt;
    /** Optional pipeline event history for event-driven widgets. */
    events?: WidgetEvents;
    /**
     * Optional freshly-classified upload type. When it changes, the host
     * resolves the type-map and surfaces the visible "switched — undo"
     * affordance (never a silent jump). Omit outside an upload flow.
     */
    uploadType?: ImageType;
}

// ─── one widget frame (NOT-MEASURED enforced here, mirrors the dock contract) ──

const WorkspaceWidgetFrame: React.FC<{ widgetId: string; receipt: WidgetReceipt; events?: WidgetEvents }> = ({ widgetId, receipt, events }) => {
    const manifest = WIDGET_BY_ID.get(widgetId);
    if (!manifest) {
        return (
            <div className="text-[11px] font-mono text-text-muted py-6 text-center" data-testid={`workspace-unknown-${widgetId}`}>
                {NOT_MEASURED}
            </div>
        );
    }
    const data = manifest.dataSelector(receipt, events);
    const Render = manifest.render;
    if (data == null) {
        return (
            <div className="text-[11px] font-mono text-text-muted py-6 text-center" data-testid={`workspace-not-measured-${widgetId}`}>
                {NOT_MEASURED}
            </div>
        );
    }
    return <Render data={data} />;
};

// ─── a leaf pane: tab bar + active widget ──────────────────────────────────────

const LeafPane: React.FC<{
    leaf: LeafNode;
    receipt: WidgetReceipt;
    events?: WidgetEvents;
    onActivate: (leafId: string, index: number) => void;
    onSplit: (leafId: string, key: string) => void;
    onClose: (leafId: string, index: number) => void;
}> = ({ leaf, receipt, events, onActivate, onSplit, onClose }) => {
    const activeId = leaf.tabs[leaf.active];
    return (
        <section
            className="flex flex-col min-w-0 min-h-0 flex-1 bg-space-900/70 border border-line rounded-xl overflow-hidden"
            data-testid={`workspace-leaf-${leaf.id}`}
        >
            <header className="flex items-stretch gap-px bg-space-850 border-b border-line overflow-x-auto" role="tablist">
                {leaf.tabs.length === 0 ? (
                    <span className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-text-faint">empty pane</span>
                ) : leaf.tabs.map((wid, i) => {
                    const title = WIDGET_BY_ID.get(wid)?.title ?? wid;
                    const isActive = i === leaf.active;
                    return (
                        <button
                            key={`${wid}-${i}`}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            data-testid={`workspace-tab-${leaf.id}-${i}`}
                            title="Focus + Arrow ↑↓←→ to split"
                            onClick={() => onActivate(leaf.id, i)}
                            onKeyDown={e => {
                                if (directionForArrow(e.key)) { e.preventDefault(); onSplit(leaf.id, e.key); }
                            }}
                            className={`group flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest whitespace-nowrap ${
                                isActive ? 'bg-accent-600 text-white' : 'bg-space-800 text-text-secondary hover:text-text-primary'
                            }`}
                        >
                            <span>{title}</span>
                            <span
                                role="button"
                                aria-label={`Close ${title}`}
                                data-testid={`workspace-tab-close-${leaf.id}-${i}`}
                                onClick={ev => { ev.stopPropagation(); onClose(leaf.id, i); }}
                                className="text-text-faint hover:text-warn leading-none"
                            >
                                ×
                            </span>
                        </button>
                    );
                })}
            </header>
            <div className="flex-1 min-h-0 overflow-auto p-4">
                {activeId
                    ? <WorkspaceWidgetFrame widgetId={activeId} receipt={receipt} events={events} />
                    : <div className="text-[11px] font-mono text-text-muted py-6 text-center" data-testid={`workspace-empty-${leaf.id}`}>{NOT_MEASURED}</div>}
            </div>
        </section>
    );
};

// ─── recursive node renderer ────────────────────────────────────────────────────

const NodeView: React.FC<{
    node: LayoutNode;
    receipt: WidgetReceipt;
    events?: WidgetEvents;
    onActivate: (leafId: string, index: number) => void;
    onSplit: (leafId: string, key: string) => void;
    onClose: (leafId: string, index: number) => void;
}> = ({ node, receipt, events, onActivate, onSplit, onClose }) => {
    if (isSplit(node)) {
        const split = node as SplitNode;
        return (
            <div
                className="flex gap-2 min-w-0 min-h-0 flex-1"
                style={{ flexDirection: split.direction === 'row' ? 'row' : 'column' }}
                data-testid={`workspace-split-${split.id}`}
                data-direction={split.direction}
            >
                {split.children.map((child, i) => (
                    <div key={child.id} className="flex min-w-0 min-h-0" style={{ flex: split.sizes[i] ?? 1 }}>
                        <NodeView node={child} receipt={receipt} events={events} onActivate={onActivate} onSplit={onSplit} onClose={onClose} />
                    </div>
                ))}
            </div>
        );
    }
    return <LeafPane leaf={node as LeafNode} receipt={receipt} events={events} onActivate={onActivate} onSplit={onSplit} onClose={onClose} />;
};

// ─── the host body (only mounted when the flag is on — hooks live here) ─────────

const WorkspaceHostBody: React.FC<WorkspaceHostProps> = ({ receipt, events, uploadType }) => {
    const [profile, setProfile] = useState<Profile>(() => loadProfile());
    const [notice, setNotice] = useState<SwitchResult | null>(null);

    const active = getActiveWorkspace(profile);
    const root: LayoutNode | null = active?.windows[0] ?? null;

    const persist = useCallback((next: Profile) => { setProfile(next); saveProfile(next); }, []);

    // Apply a layout-tree transform to the active workspace's first window.
    const applyTree = useCallback((next: LayoutNode) => {
        if (!active) return;
        persist(setActiveWindowLayout(profile, active.id, next));
    }, [active, profile, persist]);

    const onActivate = useCallback((leafId: string, index: number) => {
        if (root) applyTree(setActiveTab(root, leafId, index));
    }, [root, applyTree]);

    const onSplit = useCallback((leafId: string, key: string) => {
        const dir = directionForArrow(key);
        if (root && dir) applyTree(splitLeaf(root, leafId, dir.direction, { insertBefore: dir.insertBefore }));
    }, [root, applyTree]);

    const onClose = useCallback((leafId: string, index: number) => {
        if (root) applyTree(closeTab(root, leafId, index));
    }, [root, applyTree]);

    // Type-mapped auto-switch → visible "switched — undo" affordance (never silent).
    useEffect(() => {
        if (!uploadType) return;
        const result = resolveWorkspaceForUpload(profile, uploadType);
        if (result.switched) { setNotice(result); persist(applySwitch(profile, result)); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploadType]);

    const onUndo = () => {
        if (notice) { persist(undoSwitch(profile, notice)); setNotice(null); }
    };

    return (
        <div className="flex flex-col gap-2 p-2 min-h-0 h-full" data-testid="workspace-host">
            {notice?.switched && (
                <div
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-space-800 border border-line text-[11px]"
                    role="status"
                    data-testid="workspace-switch-notice"
                >
                    <span className="text-text-secondary">
                        Switched to <span className="text-text-primary font-bold">{notice.targetWorkspaceName}</span> workspace
                    </span>
                    <button
                        type="button"
                        onClick={onUndo}
                        data-testid="workspace-switch-undo"
                        className="ml-auto px-2 py-1 rounded bg-space-750 text-accent-400 hover:text-accent-300 text-[10px] font-bold uppercase tracking-widest"
                    >
                        Undo
                    </button>
                </div>
            )}
            <div className="flex flex-1 min-h-0">
                {root
                    ? <NodeView node={root} receipt={receipt} events={events} onActivate={onActivate} onSplit={onSplit} onClose={onClose} />
                    : <div className="text-[11px] font-mono text-text-muted p-4">No active workspace.</div>}
            </div>
        </div>
    );
};

/**
 * Public entry. DEFAULT-OFF guard first: when off, renders nothing (zero DOM,
 * no hooks). Mount is deferred to an owner-review one-liner — e.g. beside the
 * WidgetDock in the wizard chrome:
 *
 *   {getWorkspaceEnabled() && <WorkspaceHost receipt={receipt} events={events} />}
 */
export const WorkspaceHost: React.FC<WorkspaceHostProps> = (props) => {
    if (!getWorkspaceEnabled()) return null;
    return <WorkspaceHostBody {...props} />;
};
